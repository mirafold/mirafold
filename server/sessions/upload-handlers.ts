// File drag-and-drop input — the file_upload_begin/chunk/abort
// message handlers, on the fs-handlers template: per-connection state,
// handlers never throw (the local WS path has no try/catch above this, so
// an escaped throw would exit the daemon), and every well-formed request
// gets exactly one reply — errors ride a typed reply, never silence.
//
// A drop ships bytes because a browser never exposes a dropped file's real
// filesystem path; the daemon stages them OUTSIDE the working tree (no
// working-tree writes — that surface belongs to the user and the agent) and
// answers with the staged absolute path for the prompt. Cleanup rides the
// OS's tmp reaping — a deliberate decision, not an accident.

import fs from "node:fs";
import type { ConnectionContext } from "./handler-context";
import os from "node:os";
import path from "node:path";
import type { ClientMsg, WireMsg } from "../protocol";
import type { SessionEntry } from "./registry";
import { relayGateRefusal } from "../provider-policy";
import { envInt } from "../env";
import { badClientId } from "./fs-handlers";
import { createLogger } from "../log";

const log = createLogger("uploads");

// Total-size ceiling per upload. Sized for the realistic drop (an image, a
// PDF, a log) — big enough to be useful, small enough that the in-memory
// accumulation below stays trivially bounded.
export const FILE_UPLOAD_MAX_BYTES = envInt("FILE_UPLOAD_MAX_BYTES", 10_000_000);
// A drop of several files uploads them in parallel; past this the client
// queues. Bounds per-connection memory at CONCURRENT × MAX_BYTES.
export const FILE_UPLOAD_MAX_CONCURRENT = envInt("FILE_UPLOAD_MAX_CONCURRENT", 2);
// One decoded chunk's ceiling. The client sends smaller; the bound here is
// what keeps a hostile client from smuggling MAX_BYTES in one frame (the
// socket's own MAX_WS_PAYLOAD would kill the whole connection at ~1 MB —
// this refuses the upload instead).
export const FILE_UPLOAD_MAX_CHUNK_BYTES = envInt("FILE_UPLOAD_MAX_CHUNK_BYTES", 300_000);
// An upload nothing feeds is abandoned (a navigated-away page never sends
// abort) — reap it so its memory isn't held for the connection's life.
export const FILE_UPLOAD_STALL_MS = envInt("FILE_UPLOAD_STALL_MS", 30_000);

// An upload is model input staging, so it follows the prompt/cockpit relay
// gate exactly — one verdict, one wording (provider-policy.ts).

/** Path-free, control-free, bounded display name; never empty. */
export function safeUploadName(raw: unknown): string {
  const base = typeof raw === "string" ? (raw.split(/[/\\]/).pop() ?? "") : "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "dropped-file";
  return cleaned.slice(0, 120);
}

// One random, daemon-owned 0700 root per daemon (mkdtemp's mode) — never a
// fixed name under shared /tmp, where another local user could pre-create
// the parent and own every session dir beneath it (rename it away, plant a
// symlink under the next upload's name, swap a staged file's bytes before
// the agent reads it; audit 2026-08-26). The same rule the `!` cwd handoff
// follows (bang-handlers.ts). Lazy: a daemon that never stages creates none.
let uploadsRoot: string | undefined;
/** The per-session staging dir under the daemon's private root. */
export function stagingDir(sessionId: string): string {
  uploadsRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), "mirafold-uploads-"));
  return path.join(uploadsRoot, sessionId);
}

/** Create the destination exclusively and without following a link, then
 *  write: the name is the client's (sanitized), the directory is ours, and
 *  nothing pre-placed under that name can redirect or receive the bytes. */
function writeStagedFile(dir: string, name: string, bytes: Buffer): string {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? path.join(dir, name) : path.join(dir, `${stem}-${n}${ext}`);
    let fd: number;
    try {
      fd = fs.openSync(candidate, O_WRONLY | O_CREAT | O_EXCL | (O_NOFOLLOW ?? 0), 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    return candidate;
  }
}

type ActiveUpload = {
  name: string;
  size: number;
  received: number;
  chunks: Buffer[];
  stall: NodeJS.Timeout;
};

type UploadDeps = Pick<ConnectionContext, "viewport" | "getEntry" | "remote" | "isClosed">;

export type UploadHandlers = {
  begin(msg: ClientMsg & { type: "file_upload_begin" }): void;
  chunk(msg: ClientMsg & { type: "file_upload_chunk" }): void;
  abort(msg: ClientMsg & { type: "file_upload_abort" }): void;
  /** Connection closed — drop partials, clear timers. */
  dispose(): void;
};

export function createUploadHandlers({ viewport, getEntry, remote, isClosed }: UploadDeps): UploadHandlers {
  // Staging completes asynchronously; a reply must never chase a closed socket.
  const reply = (msg: WireMsg) => {
    if (!isClosed()) viewport(msg);
  };
  const active = new Map<string, ActiveUpload>();

  const fail = (id: string, message: string) => {
    const up = active.get(id);
    if (up) {
      clearTimeout(up.stall);
      active.delete(id);
    }
    reply({ type: "file_upload_error", id, message });
  };

  const armStall = (id: string, up: ActiveUpload) => {
    clearTimeout(up.stall);
    // unref: a pending stall reaper must never hold the process open — the
    // daemon's server handle keeps its loop alive, and a test child that
    // leaves an upload mid-flight would otherwise idle ~30s before exiting
    // (one leaked pair costs every Tier-1 run 30s).
    up.stall = setTimeout(() => fail(id, "upload stalled — dropped"), FILE_UPLOAD_STALL_MS);
    up.stall.unref?.();
  };

  // Completion path, shared by an ordinary final chunk and the zero-byte
  // file (complete at begin): stage the bytes, answer with the path.
  const complete = (id: string, up: ActiveUpload) => {
    clearTimeout(up.stall);
    active.delete(id);
    const entry = getEntry();
    if (!entry) {
      reply({ type: "file_upload_error", id, message: "no session attached" });
      return;
    }
    try {
      const dir = stagingDir(entry.id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const dest = writeStagedFile(dir, up.name, Buffer.concat(up.chunks));
      log.info(`staged upload ${up.name} (${up.size} bytes) → session ${entry.id}`);
      reply({ type: "file_upload_done", id, path: dest, name: up.name });
    } catch (err) {
      reply({
        type: "file_upload_error",
        id,
        message: `could not stage the file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  return {
    begin(msg) {
      if (badClientId(msg.id)) return;
      const entry = getEntry();
      if (!entry) {
        fail(msg.id, "no session attached");
        return;
      }
      const relayRefusal = remote ? relayGateRefusal(entry) : undefined;
      if (relayRefusal) {
        fail(msg.id, relayRefusal);
        return;
      }
      if (active.has(msg.id)) {
        // Refuse the NEW begin only — `fail` would tear down the healthy
        // in-flight upload that legitimately owns this id (a client
        // id-collision would destroy the original transfer mid-flight).
        reply({ type: "file_upload_error", id: msg.id, message: "duplicate upload id" });
        return;
      }
      if (active.size >= FILE_UPLOAD_MAX_CONCURRENT) {
        fail(msg.id, "too many uploads at once — retry when one finishes");
        return;
      }
      if (typeof msg.size !== "number" || !Number.isInteger(msg.size) || msg.size < 0) {
        fail(msg.id, "malformed upload size");
        return;
      }
      if (msg.size > FILE_UPLOAD_MAX_BYTES) {
        fail(
          msg.id,
          `file too large (${msg.size} bytes; the limit is ${FILE_UPLOAD_MAX_BYTES})`,
        );
        return;
      }
      const up: ActiveUpload = {
        name: safeUploadName(msg.name),
        size: msg.size,
        received: 0,
        chunks: [],
        stall: setTimeout(() => {}, 0),
      };
      active.set(msg.id, up);
      // The empty file is legal and complete at begin.
      if (up.size === 0) complete(msg.id, up);
      else armStall(msg.id, up);
    },

    chunk(msg) {
      if (badClientId(msg.id)) return;
      const up = active.get(msg.id);
      if (!up) {
        // Answer, don't hang the client's correlation: a chunk with no
        // begin (or after a failure) tells the sender its upload is dead.
        reply({ type: "file_upload_error", id: msg.id, message: "unknown upload" });
        return;
      }
      // Buffer.from(str, "base64") never throws — it silently DROPS invalid
      // characters, which under-counts `received` and turns a corrupt chunk
      // into a 30s stall-death instead of this typed error.
      // Validate the grammar explicitly: the client's encoder emits
      // exactly canonical unpadded-or-padded base64, so anything else is
      // corruption.
      if (
        typeof msg.data !== "string" ||
        msg.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(msg.data)
      ) {
        fail(msg.id, "malformed chunk");
        return;
      }
      const bytes = Buffer.from(msg.data, "base64");
      if (bytes.length > FILE_UPLOAD_MAX_CHUNK_BYTES) {
        fail(msg.id, "chunk too large");
        return;
      }
      up.received += bytes.length;
      if (up.received > up.size) {
        fail(msg.id, "more bytes than declared — dropped");
        return;
      }
      up.chunks.push(bytes);
      if (up.received < up.size) {
        armStall(msg.id, up);
        return;
      }
      complete(msg.id, up);
    },

    abort(msg) {
      if (badClientId(msg.id)) return;
      const up = active.get(msg.id);
      if (!up) return; // an abort needs no reply — the client already moved on
      clearTimeout(up.stall);
      active.delete(msg.id);
    },

    dispose() {
      for (const up of active.values()) clearTimeout(up.stall);
      active.clear();
    },
  };
}
