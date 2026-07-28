// The `!` passthrough's per-viewport request layer (4.9) — the bang /
// bang_input / bang_kill message handlers and the PTY lifecycle they drive,
// lifted out of connection.ts's switch (the fs-handlers pattern) so the
// transport-agnostic dispatcher stays free of the PTY plumbing. connection.ts
// builds one of these per connection and delegates the three cases to it.

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientMsg } from "../protocol";
import type { SessionEntry, SessionRegistry } from "./registry";
import { CLIENT_ID_RE } from "./fs-handlers";
import { spawnBang } from "../pty/pty";
import { errText } from "../adapters";

// How much of a `!` command's output rides into the agent's context with the
// next prompt (tail-kept — the end of a long output is usually the payload).
// The wire/replay stream is never capped by this; it only bounds the context
// injection so one verbose command can't eat the model's window.
const BANG_CONTEXT_CAP = Number(process.env.BANG_CONTEXT_CAP ?? 16_000);

// How much of a `!` command's output reaches the wire — and therefore
// the replay ring — per command (head-kept, honest marker; mirrors the
// TOOL_OUTPUT_CAP_BYTES pattern). Without it one runaway `!yes` floods every
// viewport, is replayed in full to each new tab, and its chunks evict the
// real transcript from the ring. The PTY keeps running past the cap and the
// agent-context tail above keeps accumulating — only the broadcast stops (R.4d).
const BANG_OUTPUT_CAP_BYTES = Number(process.env.BANG_OUTPUT_CAP_BYTES ?? 262_144);

// Minimum gap between `!` commands per session (2026-07-17 audit, finding 5):
// each bang now costs a model turn, so a hostile client bursting bangs is a
// token-burn vector, not just PTY churn. Humans never trip 400ms — the same
// threshold the action bridge uses.
const BANG_MIN_INTERVAL_MS = Number(process.env.BANG_MIN_INTERVAL_MS ?? 400);

// A handoff file bigger than the longest legal path was not written by the
// trap in pty.ts — refuse it (finding 3).
const CWD_HANDOFF_MAX_BYTES = 4096;

/**
 * The transcript is fenced by <bash-input>/<bash-output>; output that itself
 * contains a closing fence could fake the block's end and smuggle what looks
 * like user text into the agent's turn (2026-07-17 audit, finding 4).
 * Neutralize exactly that sequence — everything else reaches the model
 * verbatim. Exported for the Tier-1 test.
 */
export const escapeTranscriptFence = (s: string) => s.replaceAll("</bash-", "<\\/bash-");

// Handoff files live in a daemon-owned 0700 directory (mkdtemp's mode), not
// bare shared /tmp — on a multi-user machine no other user can pre-place,
// replace, or read them (2026-07-17 audit, finding 1). Lazy so a daemon that
// never runs a bang never creates it; individual files are removed per
// command, the dir itself lives as long as the daemon.
let bangTmpDir: string | undefined;
const newCwdHandoffFile = () =>
  path.join(
    (bangTmpDir ??= mkdtempSync(path.join(os.tmpdir(), "mirafold-bang-"))),
    `cwd-${randomUUID().slice(0, 8)}`,
  );

/**
 * Read where the shell ended up (the EXIT-trap handoff in pty.ts) and apply
 * the terminal harness's rule: `cd` persists across `!` commands, but only
 * within the workspace and its children — an escape is undone and announced
 * with the same notice the terminal shows. A missing handoff file (exotic
 * shell, the command `exec`'d away, win32) means the cwd didn't move.
 */
const applyCwdHandoff = (
  registry: SessionRegistry,
  e: SessionEntry,
  runCwd: string,
  cwdFile: string,
) => {
  let landed: string | undefined;
  try {
    // Only a small regular file — the one thing the trap writes. A FIFO the
    // command swapped in would stall readFileSync (and with it the whole
    // daemon's event loop); a symlink could point the read elsewhere; an
    // oversized file was never a path (2026-07-17 audit, finding 3). lstat
    // never follows or blocks, so it's the safe gate.
    const st = lstatSync(cwdFile);
    if (st.isFile() && st.size <= CWD_HANDOFF_MAX_BYTES) {
      // realpath also drops a trailing newline's worth of ambiguity: the
      // captured path must exist NOW or it can't become the next spawn cwd.
      landed = realpathSync(readFileSync(cwdFile, "utf8").trim());
    }
  } catch {
    /* no capture for this shell/command */
  }
  try {
    rmSync(cwdFile, { force: true });
  } catch {
    /* never let tmpfile cleanup escape into the PTY exit path */
  }
  if (!landed || landed === runCwd) return;
  let root = e.cwd;
  try {
    root = realpathSync(e.cwd); // symlinked workspace: compare realpath to realpath
  } catch {
    /* keep the un-resolved root */
  }
  const rel = path.relative(root, landed);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    e.bangCwd = landed;
  } else {
    e.bangCwd = e.cwd;
    registry.broadcast(e, { type: "notice", text: `Shell cwd was reset to ${e.cwd}` });
  }
};

/**
 * Run one `!` command in the session's PTY and drive its whole
 * lifecycle — the bang_start/…/bang_end grammar, the head-kept wire budget
 * (what viewports and the replay ring see, R.4d), and the tail-kept context
 * accumulator that rides into the agent's next prompt (4.9).
 */
const startBang = (registry: SessionRegistry, e: SessionEntry, command: string, id: string) => {
  // Tail-kept accumulator, capped as data arrives — a long-running
  // command (`!yes`) must not grow server memory until exit.
  let output = "";
  let elided = 0;
  const keepContextTail = (data: string) => {
    output += data;
    if (output.length > BANG_CONTEXT_CAP) {
      elided += output.length - BANG_CONTEXT_CAP;
      output = output.slice(-BANG_CONTEXT_CAP);
    }
  };
  // Per-command wire budget (bytes broadcast / bytes withheld) (R.4d).
  let wireSent = 0;
  let wireElided = 0;
  // Head-kept wire cap. Past it nothing is broadcast (so
  // nothing enters the ring); the marker announces the cut the
  // moment it happens, and the exit path reports the total (R.4d).
  const broadcastWireHead = (data: string) => {
    const bytes = Buffer.byteLength(data, "utf8");
    const room = BANG_OUTPUT_CAP_BYTES - wireSent;
    if (room > 0) {
      const head =
        bytes <= room
          ? data
          : new TextDecoder().decode(Buffer.from(data, "utf8").subarray(0, room));
      wireSent += Math.min(bytes, room);
      wireElided += Math.max(0, bytes - room);
      registry.broadcast(e, { type: "bang_output", data: head, id });
      if (wireSent >= BANG_OUTPUT_CAP_BYTES) {
        registry.broadcast(e, {
          type: "bang_output",
          data: `\n(… output cap reached (${BANG_OUTPUT_CAP_BYTES} bytes) — further output elided …)\n`,
          id,
        });
      }
    } else {
      wireElided += bytes;
    }
  };
  // The bang cwd can vanish between commands (we cd'd somewhere the agent
  // then deleted) — fall back to the workspace root, not a failed spawn.
  if (!existsSync(e.bangCwd)) e.bangCwd = e.cwd;
  const runCwd = e.bangCwd;
  registry.broadcast(e, { type: "bang_start", command, id });
  try {
    // Out-of-band cwd handoff file (pty.ts) — never part of the PTY stream.
    // Inside the try: a failing mkdtemp must error the session, not the daemon.
    const cwdFile = newCwdHandoffFile();
    const proc = spawnBang(
      command,
      runCwd,
      (data) => {
        keepContextTail(data);
        broadcastWireHead(data);
      },
      (exitCode) => {
        e.bang = undefined;
        if (wireElided > 0) {
          registry.broadcast(e, {
            type: "bang_output",
            data: `(… ${wireElided} bytes elided …)\n`,
            id,
          });
        }
        registry.broadcast(e, { type: "bang_end", id, exitCode });
        applyCwdHandoff(registry, e, runCwd, cwdFile);
        // The transcript goes to the agent NOW, as its own turn — the
        // terminal answers a `!` immediately, not at the next typed prompt.
        // Agent-neutral (only the pushPrompt seam), and no user_prompt
        // broadcast: the bang strip itself is the visible trigger. The cwd
        // attributes keep the agent oriented — its own tools' shell is a
        // separate process and does NOT follow a bang `cd`. Tail-kept cap;
        // echo-off input (passwords) was never in the PTY output, so it
        // can't leak into context here either.
        const tail = elided > 0 ? `(… ${elided} chars elided …)\n` + output : output;
        const after = e.bangCwd !== runCwd ? ` cwd-after="${e.bangCwd}"` : "";
        e.session.pushPrompt(
          `<bash-input cwd="${runCwd}">${escapeTranscriptFence(command)}</bash-input>\n` +
            `<bash-output exit-code="${exitCode ?? "killed"}"${after}>\n${escapeTranscriptFence(tail)}</bash-output>`,
        );
      },
      cwdFile,
    );
    e.bang = { id, proc };
  } catch (err) {
    // A throwing spawn (missing shell — the win32 /bin/bash trap, R.4f)
    // is a session-level error, never a daemon death: this handler runs
    // inside the ws message path of a process with no uncaughtException
    // net, so an escaped throw here would take every session with it.
    registry.broadcast(e, {
      type: "error",
      message: `! failed to start: ${errText(err)}`,
    });
    registry.broadcast(e, { type: "bang_end", id, exitCode: null });
  }
};

type Bang = Extract<ClientMsg, { type: "bang" }>;
type BangInput = Extract<ClientMsg, { type: "bang_input" }>;
type BangKill = Extract<ClientMsg, { type: "bang_kill" }>;

type BangDeps = {
  registry: SessionRegistry;
  /** The session this connection watches, read at call time (it can change). */
  getEntry: () => SessionEntry | null;
  /** Error to this viewport AND the terminal log (connection.ts's sendError). */
  sendError: (message: string) => void;
};

export type BangHandlers = {
  start: (msg: Bang) => void;
  input: (msg: BangInput) => void;
  kill: (msg: BangKill) => void;
};

export function createBangHandlers({ registry, getEntry, sendError }: BangDeps): BangHandlers {
  const start = (msg: Bang): void => {
    // The `!` passthrough (4.9): run it in a PTY in the session's bang
    // cwd; the finished transcript reaches the agent as its own turn.
    const entry = getEntry();
    if (!entry || typeof msg.command !== "string" || !msg.command.trim()) return;
    // `id` is a client-minted string (ClientMsg). Validate the RAW value —
    // String(msg.id) would coerce a missing/numeric id ("undefined", "123")
    // into something that passes the regex and launches a bang with a bad
    // correlation id.
    if (typeof msg.id !== "string" || !CLIENT_ID_RE.test(msg.id)) return;
    if (entry.bang) {
      sendError("a ! command is already running (stop it first)");
      return;
    }
    // The burst throttle (finding 5) — checked only when nothing is
    // running, so the already-running refusal above keeps its message.
    // The paired bang_end keeps every viewport's grammar clean (the
    // issuer's bang bar clears, like the spawn-failure path).
    if (entry.lastBangAt !== undefined && Date.now() - entry.lastBangAt < BANG_MIN_INTERVAL_MS) {
      sendError("! commands are arriving too fast — wait a moment");
      registry.broadcast(entry, { type: "bang_end", id: msg.id, exitCode: null });
      return;
    }
    entry.lastBangAt = Date.now();
    startBang(registry, entry, msg.command, msg.id);
  };

  const input = (msg: BangInput): void => {
    // EPHEMERAL SECRET PATH: straight to the PTY, nothing else — no
    // broadcast, no buffer, no log (a password may be in `data`).
    const entry = getEntry();
    if (entry?.bang && entry.bang.id === msg.id && typeof msg.data === "string") {
      entry.bang.proc.write(msg.data);
    }
  };

  const kill = (msg: BangKill): void => {
    const entry = getEntry();
    if (entry?.bang && entry.bang.id === msg.id) entry.bang.proc.kill();
  };

  return { start, input, kill };
}
