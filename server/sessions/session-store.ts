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

import type { PromptOption, SessionMeta, SessionMsg, SessionMsgBody } from "../protocol";
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
  buffer: SessionMsg[];
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
export const MAX_NEXT_SEQ = 2 ** 48;
const jsonRecordSchema = z.record(z.string(), z.unknown());
const PICKER_ROW_CAP = 10_000;
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
  // `parentId`: a subagent's prose, grouped under its spawn record.
  z
    .object({
      type: z.literal("text_delta"),
      text: z.string(),
      parentId: idSchema.optional(),
      phase: z.enum(["commentary", "final"]).optional(),
      seq: sequenceSchema,
    })
    .strict(),
  // Streamed output of a running call (TS.11): kept so a reload mid-command
  // still shows what had arrived.
  z
    .object({
      type: z.literal("tool_output_delta"),
      id: idSchema,
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
  z
    .object({
      type: z.literal("error"),
      message: z.string(),
      terminal: z.literal(false).optional(),
      seq: sequenceSchema,
    })
    .strict(),
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
      rows: z.array(pickerRowSchema).max(PICKER_ROW_CAP),
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
      type: z.literal("tool_update"),
      id: idSchema,
      detail: z.string().optional(),
      input: jsonRecordSchema.optional(),
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
      // Set when the asker is a subagent (opaque spawn handle).
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
  // `parentId`: a subagent's reasoning, grouped under its spawn record.
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
      kind: z.enum(["retry", "compaction", "rate_limit", "refusal", "warning", "info"]).optional(),
      source: z.string().max(120).optional(),
      seq: sequenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("bang_start"),
      command: z.string(),
      id: idSchema,
      silent: z.literal(true).optional(),
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
      // Any safe integer: a PTY's exit status is what it is (Windows DWORDs,
      // a sign-converted status) — displayed, never acted on.
      exitCode: z.union([z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.null()]),
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

/**
 * The registry's admission rule for one session-stream message: whatever
 * enters the ring will be checkpointed, and the decoder above is strict, so
 * one frame the decoder refuses makes the WHOLE session unrestorable at the
 * next start. Engine-authored values (a `NaN` token count, an array where a
 * record is due, an overlong id, a catalog entry with an empty label) are
 * therefore coerced where a legitimate reading exists and dropped otherwise
 * — decided HERE, against the same schemas, so the two can't drift (cold
 * review, 2026-08-26). Returns the message to broadcast, or undefined.
 */
export function admitForCheckpoint(msg: SessionMsg): SessionMsg | undefined {
  if (msg.type === "prompt_options") {
    const options = msg.options.filter((option) => promptOptionSchema.safeParse(option).success);
    return options.length === msg.options.length ? msg : { ...msg, options };
  }
  let m: SessionMsg = msg;
  if (m.type === "usage") {
    const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
    const inputTokens = count(m.inputTokens);
    const outputTokens = count(m.outputTokens);
    const costOk = m.costUsd === undefined || (typeof m.costUsd === "number" && Number.isFinite(m.costUsd) && m.costUsd >= 0);
    if (inputTokens !== m.inputTokens || outputTokens !== m.outputTokens || !costOk) {
      const { costUsd, ...rest } = m;
      m = { ...rest, inputTokens, outputTokens, ...(costOk && costUsd !== undefined ? { costUsd } : {}) };
    }
  } else if (
    (m.type === "tool_use" || m.type === "tool_update") &&
    m.input !== undefined &&
    !isObject(m.input)
  ) {
    const { input: _input, ...rest } = m;
    m = rest;
  } else if (m.type === "picker" && m.rows.length > PICKER_ROW_CAP) {
    m = { ...m, rows: m.rows.slice(0, PICKER_ROW_CAP) };
  }
  // An empty parentId is "no parent", not a subagent with an empty name.
  if ("parentId" in m && m.parentId === "") {
    const { parentId: _p, ...rest } = m;
    m = rest as SessionMsg;
  }
  // Judge — and return — the frame without a caller-supplied seq/replay:
  // the ring stamps seq itself, and a `replay` flag that rode in would be
  // stored and then refused by the strict decoder (cold review, round 3).
  const { seq: _seq, replay: _replay, ...body } = m;
  const judged = ("seq" in m || "replay" in m ? body : m) as SessionMsg;
  return storedWireMessageSchema.safeParse({ ...body, seq: 1 }).success ? judged : undefined;
}

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
    const base = {
      agent: b.agent,
      kind: b.kind,
      live: b.live,
      ...(b.model !== undefined ? { model: b.model } : {}),
      ...(b.provider !== undefined ? { provider: b.provider } : {}),
    };
    if (b.endpoint === undefined) return base;
    if (b.endpointSource === "configured") {
      return { ...base, endpoint: b.endpoint, endpointSource: "configured", endpointAuth: b.endpointAuth ?? "none" };
    }
    // Discovered — including an endpoint saved before `endpointSource`
    // existed: recovering it as a discovered, unauthenticated target
    // preserves the conversation; silently attaching a current credential
    // would not be safe.
    return {
      ...base,
      endpoint: b.endpoint,
      endpointSource: "discovered",
      ...(b.agent === "claude-code" ? { endpointAuth: "none" as const } : {}),
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
  // Bounded with HEADROOM, not at the safe-integer edge: a restored ring
  // increments from here for the session's whole life, and at 2^53−1 the
  // very next `nextSeq++` is a no-op that freezes every later seq (the
  // 1e300 case decoded outright before 2026-08-26; MAX_SAFE_INTEGER itself
  // pinned the stream after one message — cold review). 2^48 is beyond any
  // real session by a factor of ~10^9 and leaves 2^5 × 2^48 of room.
  nextSeq: z.number().int().min(1).max(MAX_NEXT_SEQ),
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

// Compile-time: the stored schema covers exactly the transcript — every
// message broadcast() can deliver has a strict schema above, and no
// per-viewport message does. prompt_options is the replaceable catalog kept
// beside the transcript, not in it.
type StoredType = z.infer<typeof storedWireMessageSchema>["type"];
type TranscriptType = Exclude<SessionMsgBody["type"], "prompt_options">;
const storedCoversTranscript: [
  Exclude<TranscriptType, StoredType>,
  Exclude<StoredType, TranscriptType>,
] extends [never, never]
  ? true
  : never = true;
void storedCoversTranscript;

function decodeTranscript(raw: unknown[], backend: Backend): SessionMsg[] {
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
      // catalogs saved without `source` before their first replay.
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
