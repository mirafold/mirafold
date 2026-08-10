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

import type { PromptOption, SessionMeta, WireMsg } from "../protocol";
import type { Backend } from "../adapters";
import { createLogger, stateDir } from "../log";

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

function decodeStoredSession(raw: unknown, expectedId: string): StoredSession {
  if (!isObject(raw) || raw.version !== SCHEMA_VERSION || raw.id !== expectedId) {
    throw new Error("unsupported or mismatched checkpoint");
  }
  if (
    typeof raw.cwd !== "string" ||
    typeof raw.bangCwd !== "string" ||
    typeof raw.name !== "string" ||
    !Number.isInteger(raw.nextSeq) ||
    (raw.nextSeq as number) < 1 ||
    typeof raw.lastActivity !== "number" ||
    typeof raw.createdAt !== "number" ||
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
  const backend = raw.backend;
  if (!isObject(backend)) throw new Error("malformed checkpoint backend");
  const agent = backend.agent;
  const kind = backend.kind;
  if (
    (agent !== "claude-code" && agent !== "codex" && agent !== "gemini-cli") ||
    (kind !== "none" && kind !== "api-key" && kind !== "subscription" && kind !== "local") ||
    typeof backend.live !== "boolean"
  ) {
    throw new Error("malformed checkpoint backend");
  }
  for (const key of ["model", "endpoint", "provider"] as const) {
    if (backend[key] !== undefined && typeof backend[key] !== "string") {
      throw new Error("malformed checkpoint backend");
    }
  }
  if (
    (raw.resumeId !== undefined &&
      (typeof raw.resumeId !== "string" || raw.resumeId.length === 0 || raw.resumeId.length > 512)) ||
    (raw.model !== undefined && typeof raw.model !== "string")
  ) {
    throw new Error("malformed checkpoint provider identity");
  }
  const buffer = raw.buffer as unknown[];
  for (const msg of buffer) {
    if (!isObject(msg) || typeof msg.type !== "string") {
      throw new Error("malformed checkpoint transcript");
    }
    if (msg.seq !== undefined && (!Number.isInteger(msg.seq) || (msg.seq as number) < 1)) {
      throw new Error("malformed checkpoint sequence");
    }
  }
  const promptOptions = raw.promptOptions as unknown[];
  for (const rawOption of promptOptions) {
    if (!isObject(rawOption)) throw new Error("malformed prompt catalog");
    if (
      (rawOption.trigger !== "/" && rawOption.trigger !== "$") ||
      typeof rawOption.value !== "string" ||
      typeof rawOption.label !== "string" ||
      (rawOption.kind !== "command" && rawOption.kind !== "skill") ||
      (rawOption.description !== undefined && typeof rawOption.description !== "string") ||
      (rawOption.argumentHint !== undefined && typeof rawOption.argumentHint !== "string") ||
      (rawOption.aliases !== undefined &&
        (!Array.isArray(rawOption.aliases) ||
          rawOption.aliases.some((alias) => typeof alias !== "string")))
    ) {
      throw new Error("malformed prompt catalog");
    }
  }
  const usage = raw.usage;
  if (
    usage !== undefined &&
    (!isObject(usage) ||
      typeof usage.inputTokens !== "number" ||
      typeof usage.outputTokens !== "number" ||
      (usage.costUsd !== undefined && typeof usage.costUsd !== "number"))
  ) {
    throw new Error("malformed checkpoint usage");
  }
  return {
    version: SCHEMA_VERSION,
    id: expectedId,
    cwd: raw.cwd,
    bangCwd: raw.bangCwd,
    backend: {
      agent,
      kind,
      live: backend.live,
      ...(typeof backend.model === "string" ? { model: backend.model } : {}),
      ...(typeof backend.endpoint === "string" ? { endpoint: backend.endpoint } : {}),
      ...(typeof backend.provider === "string" ? { provider: backend.provider } : {}),
    },
    ...(typeof raw.resumeId === "string" ? { resumeId: raw.resumeId } : {}),
    promptOptions: promptOptions as PromptOption[],
    buffer: buffer as WireMsg[],
    nextSeq: raw.nextSeq as number,
    name: raw.name,
    status,
    lastActivity: raw.lastActivity,
    createdAt: raw.createdAt,
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(usage ? { usage: usage as StoredSession["usage"] } : {}),
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
