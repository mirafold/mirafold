import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { PromptOption, SessionMeta, WireMsg } from "../protocol";
import type { Backend } from "../adapters";
import { createLogger, scrubSelectedEndpoint, stateDir } from "../log";
import {
  PROMPT_ALIAS_CAP,
  PROMPT_DESCRIPTION_CAP,
  PROMPT_LABEL_CAP,
  PROMPT_OPTION_CAP,
  PROMPT_VALUE_CAP,
  promptOptionIsControlSafe,
} from "../prompt-options";
import { BUFFER_CAP, MAX_CHECKPOINT_BYTES } from "./limits";

const log = createLogger("session-store");
const SCHEMA_VERSION = 1;
// A record written by Mirafold never exceeds the ring's count cap; rejecting
// more keeps a corrupt local file from expanding into an unbounded array
// during recovery.
const MAX_BUFFER_MESSAGES = BUFFER_CAP;
const MAX_PROMPT_OPTIONS = PROMPT_OPTION_CAP;
// normalizePromptOptions caps each text and appends one ellipsis character,
// so the longest legitimate stored form is the cap plus one.
const CAPPED = (cap: number) => cap + 1;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type StoredSession = {
  version: typeof SCHEMA_VERSION;
  id: string;
  cwd: string;
  bangCwd: string;
  backend: Backend;
  resumeId?: string;
  promptOptions: PromptOption[];
  buffer: WireMsg[];
  nextSeq: number;
  name: string;
  status: SessionMeta["status"];
  lastActivity: number;
  createdAt: number;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
};

export type StoredSessionIndex = {
  sessions: Map<string, StoredSession>;
  errors: Map<string, string>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeIntSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const idSchema = z.string().min(1).max(1_024);
const jsonRecordSchema = z.record(z.string(), z.unknown());
const pickerRowSchema = z
  .object({
    label: z.string(),
    detail: z.string().optional(),
    current: z.boolean().optional(),
    text: z.string(),
  })
  .strict();

// Only messages that pass through SessionRegistry.deliver() belong in a
// checkpoint transcript. Per-viewport plumbing (agents, session_created,
// fs_*, pong, fleet snapshots) and replaceable prompt_options are excluded.
// Every object is strict and sequenced: a locally tampered/corrupt record can
// never smuggle an arbitrary frame back into the trusted browser shell.
const storedWireMessageSchema = z.discriminatedUnion("type", [
  // `parentId` (SA.2): a subagent's prose, grouped under its spawn record.
  z
    .object({
      type: z.literal("text_delta"),
      text: z.string(),
      parentId: idSchema.optional(),
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("status"),
      state: z.enum(["thinking", "tool"]),
      label: z.string().optional(),
      seq: sequenceSchema,
    })
    .strict(),
  z.object({ type: z.literal("turn_end"), seq: sequenceSchema }).strict(),
  z.object({ type: z.literal("error"), message: z.string(), seq: sequenceSchema }).strict(),
  z
    .object({
      type: z.literal("render"),
      component: z.string(),
      props: jsonRecordSchema,
      id: idSchema,
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("picker"),
      id: idSchema,
      title: z.string(),
      rows: z.array(pickerRowSchema).max(10_000),
      hint: z.string().optional(),
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_use"),
      name: z.string(),
      detail: z.string().optional(),
      id: idSchema,
      input: jsonRecordSchema.optional(),
      parentId: idSchema.optional(),
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      output: z.string(),
      isError: z.boolean().optional(),
      id: idSchema,
      truncatedBytes: nonnegativeIntSchema.optional(),
      parentId: idSchema.optional(),
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("permission_request"),
      tool: z.string(),
      detail: z.string(),
      id: idSchema,
      // SA.3: set when the asker is a subagent (opaque spawn handle).
      parentId: idSchema.optional(),
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("permission_resolved"),
      id: idSchema,
      allow: z.boolean(),
      seq: sequenceSchema,
    })
    .strict(),
  z.object({ type: z.literal("user_prompt"), text: z.string(), seq: sequenceSchema }).strict(),
  z
    .object({
      type: z.literal("artifact"),
      html: z.string(),
      id: idSchema,
      title: z.string().optional(),
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("usage"),
      model: z.string().optional(),
      inputTokens: nonnegativeIntSchema,
      outputTokens: nonnegativeIntSchema,
      costUsd: z.number().nonnegative().optional(),
      seq: sequenceSchema,
    })
    .strict(),
  // `parentId` (SA.2): a subagent's reasoning, grouped under its spawn record.
  z
    .object({
      type: z.literal("thinking_delta"),
      text: z.string(),
      parentId: idSchema.optional(),
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("notice"),
      text: z.string(),
      kind: z.enum(["retry", "compaction", "rate_limit", "refusal", "warning"]).optional(),
      source: z.string().max(120).optional(),
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("bang_start"),
      command: z.string(),
      id: idSchema,
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("bang_output"),
      data: z.string(),
      id: idSchema,
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("bang_end"),
      id: idSchema,
      exitCode: z.union([nonnegativeIntSchema, z.null()]),
      seq: sequenceSchema,
    })
    .strict(),
]);

const promptOptionSchema = z
  .object({
    trigger: z.enum(["/", "$"]),
    value: z.string().min(2).max(PROMPT_VALUE_CAP),
    label: z.string().min(1).max(CAPPED(PROMPT_LABEL_CAP)),
    description: z.string().max(CAPPED(PROMPT_DESCRIPTION_CAP)).optional(),
    argumentHint: z.string().max(CAPPED(PROMPT_VALUE_CAP)).optional(),
    kind: z.enum(["command", "skill"]),
    aliases: z.array(z.string().max(PROMPT_VALUE_CAP)).max(PROMPT_ALIAS_CAP).optional(),
    source: z.enum(["claude-code", "codex", "gemini-cli", "opencode", "mirafold"]).optional(),
  })
  .strict()
  .refine(
    (option) =>
      option.value.startsWith(option.trigger) &&
      ((option.trigger === "/" && option.kind === "command") ||
        (option.trigger === "$" && option.kind === "skill")) &&
      promptOptionIsControlSafe(option),
    { message: "unsafe prompt catalog entry" },
  );

const httpEndpointSchema = z.string().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
});

/** A saved `Backend`. Unknown keys are dropped, never fatal (the record is
 *  ours; an older daemon's extra field must not strand a session). The
 *  co-occurrence rules are the ones `adapters/index.ts` produces; a record
 *  outside them is treated as tampering. */
const storedBackendSchema = z
  .object({
    agent: z.enum(["claude-code", "codex", "gemini-cli", "opencode"]),
    kind: z.enum(["none", "api-key", "subscription", "local", "gateway"]),
    live: z.boolean(),
    model: z.string().optional(),
    endpoint: httpEndpointSchema.optional(),
    provider: z.string().optional(),
    endpointSource: z.enum(["configured", "discovered"]).optional(),
    endpointAuth: z.enum(["api-key", "auth-token", "none"]).optional(),
  })
  .refine(
    (b) =>
      !(b.endpoint !== undefined && b.provider !== undefined) &&
      // An endpoint (and its source/auth) belongs to a `local` backend only.
      !(
        (b.endpoint !== undefined || b.endpointSource !== undefined || b.endpointAuth !== undefined) &&
        b.kind !== "local"
      ) &&
      // OpenCode's `provider` is the published CLASSIFICATION annotation and
      // rides with any kind; for other agents it is a local-provider identity.
      !(b.provider !== undefined && b.kind !== "local" && b.agent !== "opencode") &&
      !(b.kind === "gateway" && b.agent !== "opencode") &&
      !(b.endpointSource !== undefined && b.endpoint === undefined) &&
      // Configured (env) endpoints and header-credential modes are Claude-only.
      !(b.endpointSource === "configured" && b.agent !== "claude-code") &&
      !(b.endpointAuth !== undefined && b.agent !== "claude-code") &&
      // A real credential mode rides only with a configured endpoint.
      !(b.endpointAuth !== undefined && b.endpointSource !== "configured" && b.endpointAuth !== "none"),
  )
  .transform((b): Backend => {
    // A Claude endpoint saved before source/auth existed: recover it as a
    // discovered, unauthenticated target — preserving the conversation is
    // safe, silently attaching a current credential would not be.
    const legacyClaudeEndpoint =
      b.agent === "claude-code" && b.kind === "local" && b.endpoint !== undefined && b.endpointSource === undefined;
    const endpointSource = legacyClaudeEndpoint ? "discovered" : b.endpointSource;
    const endpointAuth = legacyClaudeEndpoint ? "none" : b.endpointAuth;
    return {
      agent: b.agent,
      kind: b.kind,
      live: b.live,
      ...(b.model !== undefined ? { model: b.model } : {}),
      ...(b.endpoint !== undefined ? { endpoint: b.endpoint } : {}),
      ...(endpointSource !== undefined ? { endpointSource } : {}),
      ...(endpointAuth !== undefined ? { endpointAuth } : {}),
      ...(b.provider !== undefined ? { provider: b.provider } : {}),
    };
  });

const finiteNonnegativeSchema = z.number().finite().nonnegative();

const storedUsageSchema = z.object({
  inputTokens: nonnegativeIntSchema,
  outputTokens: nonnegativeIntSchema,
  costUsd: finiteNonnegativeSchema.optional(),
});

/** The checkpoint envelope — everything except the transcript and catalog,
 *  which have their own decoders below. Version and id are checked before
 *  this runs so a foreign record reports "mismatched", not "malformed". */
const storedMetadataSchema = z.object({
  cwd: z.string(),
  bangCwd: z.string(),
  name: z.string(),
  nextSeq: z.number().int().min(1),
  lastActivity: finiteNonnegativeSchema,
  createdAt: finiteNonnegativeSchema,
  status: z.enum(["idle", "working", "permission"]),
  backend: storedBackendSchema,
  resumeId: z.string().min(1).max(512).optional(),
  model: z.string().optional(),
  usage: storedUsageSchema.optional(),
  buffer: z.array(z.unknown()).max(MAX_BUFFER_MESSAGES),
  promptOptions: z.array(z.unknown()).max(MAX_PROMPT_OPTIONS),
});

function decodeTranscript(raw: unknown[], backend: Backend): WireMsg[] {
  let decoded: z.infer<typeof storedWireMessageSchema>[];
  try {
    decoded = z.array(storedWireMessageSchema).parse(raw);
  } catch {
    throw new Error("malformed checkpoint transcript");
  }
  let previous = 0;
  for (const msg of decoded) {
    if (msg.seq <= previous) {
      throw new Error("malformed checkpoint sequence");
    }
    previous = msg.seq;
  }
  return decoded.map((msg) => {
    if (msg.type === "error") {
      return { ...msg, message: scrubSelectedEndpoint(msg.message, backend.endpoint) };
    }
    if (msg.type === "notice" && msg.source) {
      return { ...msg, text: scrubSelectedEndpoint(msg.text, backend.endpoint) };
    }
    return msg;
  });
}

function decodePromptOptions(raw: unknown[], backend: Backend): PromptOption[] {
  try {
    return z.array(promptOptionSchema).parse(raw).map((option) => {
      // Provenance is recomputed from trusted checkpoint backend identity,
      // never trusted from the mutable record itself. This also migrates
      // pre-UX.8 catalogs before their first replay.
      const { source: _storedSource, ...catalog } = option;
      const source =
        backend.live && backend.agent === "claude-code"
          ? ("claude-code" as const)
          : backend.live && backend.agent === "codex" && option.trigger === "$"
            ? ("codex" as const)
            : !backend.live && option.trigger === "$"
              ? ("mirafold" as const)
              : undefined;
      return source ? { ...catalog, source } : catalog;
    });
  } catch {
    throw new Error("malformed prompt catalog");
  }
}

function decodeStoredSession(raw: unknown, expectedId: string): StoredSession {
  if (!isObject(raw) || raw.version !== SCHEMA_VERSION || raw.id !== expectedId) {
    throw new Error("unsupported or mismatched checkpoint");
  }
  const parsed = storedMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    // Name the part that failed so a log line points at backend/usage/status
    // rather than the whole record.
    const part = String(parsed.error.issues[0]?.path[0] ?? "metadata");
    throw new Error(
      `malformed checkpoint ${["backend", "usage", "status"].includes(part) ? part : "metadata"}`,
    );
  }
  const m = parsed.data;
  const buffer = decodeTranscript(m.buffer, m.backend);
  if ((buffer.at(-1)?.seq ?? 0) >= m.nextSeq) {
    throw new Error("malformed checkpoint sequence");
  }
  const promptOptions = decodePromptOptions(m.promptOptions, m.backend);
  return {
    version: SCHEMA_VERSION,
    id: expectedId,
    cwd: m.cwd,
    bangCwd: m.bangCwd,
    backend: m.backend,
    ...(m.resumeId !== undefined ? { resumeId: m.resumeId } : {}),
    promptOptions,
    buffer,
    nextSeq: m.nextSeq,
    name: m.name,
    status: m.status,
    lastActivity: m.lastActivity,
    createdAt: m.createdAt,
    ...(m.model !== undefined ? { model: m.model } : {}),
    ...(m.usage ? { usage: m.usage } : {}),
  };
}

/** Owner-only, atomic local checkpoints. No dependency is warranted here:
 * this is one bounded JSON record per session, not a database or a protocol. */
export class SessionCheckpointStore {
  constructor(
    readonly directory = process.env.MIRAFOLD_SESSION_DIR || path.join(stateDir(), "sessions"),
  ) {}

  loadAll(): StoredSessionIndex {
    const sessions = new Map<string, StoredSession>();
    const errors = new Map<string, string>();
    if (!existsSync(this.directory)) return { sessions, errors };
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch (err) {
      log.warn(`could not list saved sessions: ${err instanceof Error ? err.message : String(err)}`);
      return { sessions, errors };
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!SESSION_ID.test(id)) continue;
      try {
        const file = path.join(this.directory, name);
        if (statSync(file).size > MAX_CHECKPOINT_BYTES) throw new Error("checkpoint is too large");
        const stored = decodeStoredSession(JSON.parse(readFileSync(file, "utf8")), id);
        sessions.set(id, stored);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.set(id, message);
        log.warn(`saved session ${id} is unavailable: ${message}`);
      }
    }
    return { sessions, errors };
  }

  write(session: StoredSession) {
    if (!SESSION_ID.test(session.id)) throw new Error("invalid session id");
    const data = JSON.stringify(session);
    if (Buffer.byteLength(data) > MAX_CHECKPOINT_BYTES) {
      throw new Error("session checkpoint exceeds the 40 MB safety limit");
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.directory, 0o700);
    } catch {
      // Windows and restrictive filesystems may not implement POSIX modes.
    }
    const target = path.join(this.directory, `${session.id}.json`);
    const temp = path.join(this.directory, `.${session.id}.${process.pid}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, target);
      try {
        chmodSync(target, 0o600);
      } catch {
        // See directory chmod note above.
      }
    } catch (err) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        // The temp may never have been created or may already be renamed.
      }
      throw err;
    }
  }

  delete(id: string) {
    if (!SESSION_ID.test(id)) return;
    try {
      unlinkSync(path.join(this.directory, `${id}.json`));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }
}
