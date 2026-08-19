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
import { promptOptionIsControlSafe } from "../prompt-options";

const log = createLogger("session-store");
const SCHEMA_VERSION = 1;
const MAX_CHECKPOINT_BYTES = 40_000_000;
// Must match the registry's fixed replay-ring count ceiling. A record written
// by Mirafold never exceeds it; rejecting more keeps a corrupt local file from
// expanding into an unbounded array during recovery.
const MAX_BUFFER_MESSAGES = 4_000;
const MAX_PROMPT_OPTIONS = 500;
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
    value: z.string().min(2).max(200),
    label: z.string().min(1).max(121),
    description: z.string().max(501).optional(),
    argumentHint: z.string().max(201).optional(),
    kind: z.enum(["command", "skill"]),
    aliases: z.array(z.string().max(200)).max(20).optional(),
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

function decodeBackend(raw: unknown): Backend {
  if (!isObject(raw)) throw new Error("malformed checkpoint backend");
  const agent = raw.agent;
  const kind = raw.kind;
  if (
    (agent !== "claude-code" && agent !== "codex" && agent !== "gemini-cli" && agent !== "opencode") ||
    (kind !== "none" &&
      kind !== "api-key" &&
      kind !== "subscription" &&
      kind !== "local" &&
      kind !== "gateway") ||
    typeof raw.live !== "boolean"
  ) {
    throw new Error("malformed checkpoint backend");
  }
  for (const key of ["model", "endpoint", "provider", "endpointSource", "endpointAuth"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") {
      throw new Error("malformed checkpoint backend");
    }
  }
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint : undefined;
  const provider = typeof raw.provider === "string" ? raw.provider : undefined;
  const rawSource = raw.endpointSource;
  const rawAuth = raw.endpointAuth;
  if (
    (rawSource !== undefined && rawSource !== "configured" && rawSource !== "discovered") ||
    (rawAuth !== undefined && rawAuth !== "api-key" && rawAuth !== "auth-token" && rawAuth !== "none") ||
    (endpoint !== undefined && provider !== undefined) ||
    // OC.4c: an OpenCode backend's `provider` is the published CLASSIFICATION
    // annotation and rides with ANY kind; for other agents it stays a
    // local-provider identity. Every checkpointed OpenCode session was
    // rejected here after a daemon restart (bughunt round 2, reproduced).
    ((endpoint !== undefined || rawSource !== undefined || rawAuth !== undefined) &&
      kind !== "local") ||
    (provider !== undefined && kind !== "local" && agent !== "opencode") ||
    (kind === "gateway" && agent !== "opencode") ||
    (rawSource !== undefined && endpoint === undefined) ||
    (rawSource === "configured" && agent !== "claude-code") ||
    (rawAuth !== undefined && agent !== "claude-code") ||
    (rawAuth !== undefined && rawSource !== "configured" && rawAuth !== "none")
  ) {
    throw new Error("malformed checkpoint backend");
  }
  if (endpoint !== undefined) {
    try {
      const protocol = new URL(endpoint).protocol;
      if (protocol !== "http:" && protocol !== "https:") {
        throw new Error("unsupported endpoint protocol");
      }
    } catch {
      throw new Error("malformed checkpoint backend");
    }
  }
  // A pre-UX.8 Claude endpoint had no source/auth fields. Recover it as a
  // discovered, unauthenticated target: preserving the conversation is safe,
  // silently attaching a current credential would not be.
  const legacyClaudeEndpoint =
    agent === "claude-code" && kind === "local" && endpoint !== undefined && rawSource === undefined;
  const endpointSource = legacyClaudeEndpoint ? "discovered" : rawSource;
  const endpointAuth = legacyClaudeEndpoint ? "none" : rawAuth;
  return {
    agent,
    kind,
    live: raw.live,
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(endpointSource === "configured" || endpointSource === "discovered"
      ? { endpointSource }
      : {}),
    ...(endpointAuth === "api-key" || endpointAuth === "auth-token" || endpointAuth === "none"
      ? { endpointAuth }
      : {}),
    ...(provider !== undefined ? { provider } : {}),
  };
}

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

function decodeUsage(raw: unknown): StoredSession["usage"] {
  if (
    raw !== undefined &&
    (!isObject(raw) ||
      !Number.isSafeInteger(raw.inputTokens) ||
      (raw.inputTokens as number) < 0 ||
      !Number.isSafeInteger(raw.outputTokens) ||
      (raw.outputTokens as number) < 0 ||
      (raw.costUsd !== undefined &&
        (typeof raw.costUsd !== "number" || !Number.isFinite(raw.costUsd) || raw.costUsd < 0)))
  ) {
    throw new Error("malformed checkpoint usage");
  }
  return raw as StoredSession["usage"];
}

function decodeStoredSession(raw: unknown, expectedId: string): StoredSession {
  if (!isObject(raw) || raw.version !== SCHEMA_VERSION || raw.id !== expectedId) {
    throw new Error("unsupported or mismatched checkpoint");
  }
  if (
    typeof raw.cwd !== "string" ||
    typeof raw.bangCwd !== "string" ||
    typeof raw.name !== "string" ||
    !Number.isSafeInteger(raw.nextSeq) ||
    (raw.nextSeq as number) < 1 ||
    typeof raw.lastActivity !== "number" ||
    !Number.isFinite(raw.lastActivity) ||
    raw.lastActivity < 0 ||
    typeof raw.createdAt !== "number" ||
    !Number.isFinite(raw.createdAt) ||
    raw.createdAt < 0 ||
    !Array.isArray(raw.buffer) ||
    raw.buffer.length > MAX_BUFFER_MESSAGES ||
    !Array.isArray(raw.promptOptions) ||
    raw.promptOptions.length > MAX_PROMPT_OPTIONS
  ) {
    throw new Error("malformed checkpoint metadata");
  }
  const status = raw.status;
  if (status !== "idle" && status !== "working" && status !== "permission") {
    throw new Error("malformed checkpoint status");
  }
  const backend = decodeBackend(raw.backend);
  if (
    (raw.resumeId !== undefined &&
      (typeof raw.resumeId !== "string" || raw.resumeId.length === 0 || raw.resumeId.length > 512)) ||
    (raw.model !== undefined && typeof raw.model !== "string")
  ) {
    throw new Error("malformed checkpoint provider identity");
  }
  const buffer = decodeTranscript(raw.buffer as unknown[], backend);
  if ((buffer.at(-1)?.seq ?? 0) >= (raw.nextSeq as number)) {
    throw new Error("malformed checkpoint sequence");
  }
  const promptOptions = decodePromptOptions(raw.promptOptions as unknown[], backend);
  const usage = decodeUsage(raw.usage);
  return {
    version: SCHEMA_VERSION,
    id: expectedId,
    cwd: raw.cwd,
    bangCwd: raw.bangCwd,
    backend,
    ...(typeof raw.resumeId === "string" ? { resumeId: raw.resumeId } : {}),
    promptOptions,
    buffer,
    nextSeq: raw.nextSeq as number,
    name: raw.name,
    status,
    lastActivity: raw.lastActivity,
    createdAt: raw.createdAt,
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(usage ? { usage } : {}),
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
