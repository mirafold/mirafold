import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentName, ClientMsg, WireMsg } from "../protocol";
import type { SessionEntry, SessionRegistry } from "./registry";
import { runActionTool } from "./actions";
import { availableAgents, defaultAgent } from "../adapters";
import { allowedOverRelay } from "../provider-policy";
import { spawnBang } from "../pty/pty";
import { VERSION } from "../version";

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
  // Per-command wire budget (bytes broadcast / bytes withheld) (R.4d).
  let wireSent = 0;
  let wireElided = 0;
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
        output += data;
        if (output.length > BANG_CONTEXT_CAP) {
          elided += output.length - BANG_CONTEXT_CAP;
          output = output.slice(-BANG_CONTEXT_CAP);
        }
        // Head-kept wire cap. Past it nothing is broadcast (so
        // nothing enters the ring); the marker announces the cut the
        // moment it happens, and the exit path reports the total (R.4d).
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
      message: `! failed to start: ${err instanceof Error ? err.message : String(err)}`,
    });
    registry.broadcast(e, { type: "bang_end", id, exitCode: null });
  }
};

// Agents the browser is allowed to name at onboarding (P.4). A create message
// naming anything else falls back to the daemon default rather than erroring.
const OFFERABLE = new Set(availableAgents().map((a) => a.agent));
const asAgent = (v: unknown): AgentName | undefined =>
  typeof v === "string" && OFFERABLE.has(v as AgentName) ? (v as AgentName) : undefined;

export type Connection = {
  /** Feed one raw client frame (JSON text) into this viewport. */
  handleMessage: (raw: string) => void;
  /** The transport is gone — detach from whatever this viewport watched. */
  close: () => void;
};

/**
 * One viewport's server side, transport-agnostic (Phase R.1). The local
 * WebSocket path and relay-multiplexed remote viewports share exactly this
 * logic, so to the registry a remote device is just another attached
 * viewport — same hello, same message grammar, same detach-on-close.
 */
export function openConnection(
  registry: SessionRegistry,
  viewport: (msg: WireMsg) => void,
  label = "ws",
  // Pairing info for the "connect a device" QR. The local WS path passes
  // it; the relay path never does — the code must not cross the relay (R.4).
  relay?: { url: string; code: string },
  // True for a viewport arriving over the paid relay (relay-client passes
  // it). The relay gate refuses to attach such a viewport to a subscription-
  // backed session; local viewports are never gated (R.4i).
  remote = false,
): Connection {
  // A connection is a viewport onto one registry session (Step 4.2) — or,
  // since 4.6, a fleet watcher observing the registry itself.
  let entry: SessionEntry | null = null;
  let watching = false;

  // Identity first, then the replayed history, then the live stream. 4.4:
  // a valid afterSeq turns the replay into a tail-only resume — the client
  // is told via `resumed` so it keeps its state instead of repainting.
  const attachTo = (e: SessionEntry, afterSeq?: number, fallback = false) => {
    // The relay gate. A remote viewport may not drive a subscription-
    // backed session — charging for remote access to it trips the closed-model
    // providers' reselling clauses (provider-policy.ts). Refuse WITHOUT
    // attaching, and leave `entry` as it was so the viewport keeps whatever it
    // legitimately watched. Local viewports are never gated. (A remote CREATE
    // that lands here leaves the just-created session unattached; it's idle-
    // reaped — the important case this closes is a phone attaching to a
    // subscription session a local tab started.) (R.4i)
    if (remote && !allowedOverRelay(e.kind)) {
      viewport({
        type: "refused",
        reason: "subscription-relay",
        message:
          "This session runs on a subscription login, which can't be used over the relay. Use an API key to drive an agent remotely.",
      });
      console.log(`[${label}] refused remote viewport → session ${e.id} (${e.kind})`);
      return;
    }
    if (entry) registry.detach(entry, viewport);
    entry = e;
    const resumed = afterSeq !== undefined && registry.canResume(e, afterSeq);
    viewport({
      type: "session_created",
      sessionId: e.id,
      cwd: e.cwd,
      agent: e.agent,
      model: e.session.modelName,
      ...(resumed ? { resumed: true } : {}),
      ...(e.live ? {} : { demo: true }),
      // The caller asked for a session that no longer exists and got a
      // fresh one — the shell shows a notice instead of a silent swap (R.4c).
      ...(fallback ? { fallback: true } : {}),
    });
    registry.attach(e, viewport, resumed ? afterSeq : undefined);
    console.log(
      `[${label}] viewport ${resumed ? `resumed @${afterSeq}` : "attached"} → session ${e.id} (${e.viewports.size} viewport(s))`,
    );
  };

  // Advertise which agents this daemon offers + which are live, so the
  // onboarding picker can render before any session exists. No agent assumed (P.4).
  // Also where the daemon was launched — the default cwd for new
  // sessions — plus home, so the client can show paths in ~-form (4.8).
  viewport({
    type: "agents",
    agents: availableAgents(),
    default: defaultAgent(),
    cwd: process.cwd(),
    home: os.homedir(),
    version: VERSION,
    ...(relay ? { relay } : {}),
  });

  // A viewport-scoped error reaches the terminal too — the browser may
  // be a stranger's; the terminal log is what lands in a bug report (R.4g).
  const sendError = (message: string) => {
    console.error(`[${new Date().toISOString()}] [${label}] error: ${message}`);
    viewport({ type: "error", message });
  };

  // The client announces its build on attach/create; a skewed pair is
  // the first thing to know about a weird bug report, so log it here (R.4g).
  const noteClientVersion = (v: unknown) => {
    if (typeof v === "string" && v && v !== VERSION) {
      console.warn(
        `[${new Date().toISOString()}] [${label}] version skew: client v${v}, daemon v${VERSION}`,
      );
    }
  };

  const handleMessage = (raw: string) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      sendError("malformed client message");
      return;
    }
    // A frame that parses to a non-object (`null`, a number, a bare string)
    // has no `.type` — and `null.type` THROWS, which on the local WS path
    // (index.ts has no try/catch around handleMessage) escapes to the
    // uncaughtException handler and exits the daemon. Reject it here, the same
    // shape as bad JSON. Unknown-but-object types still fall through the switch
    // untouched (the R.4h ignore-unknown contract).
    if (typeof msg !== "object" || msg === null) {
      sendError("malformed client message");
      return;
    }
    switch (msg.type) {
      case "create":
        // A bad cwd (typo'd path) rejects the create rather than silently
        // working somewhere else — the viewport stays unattached and the
        // onboarding card shows the error (Step 4.8).
        noteClientVersion(msg.clientVersion);
        try {
          attachTo(
            registry.create({
              cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
              agent: asAgent(msg.agent),
            }),
          );
        } catch (err) {
          sendError(err instanceof Error ? err.message : String(err));
        }
        break;
      case "attach": {
        // A stale/unknown id (old bookmark, server restart) gets a fresh
        // session rather than an error page — unless the session cap rejects
        // the fallback create, which surfaces as an error (not a crash).
        noteClientVersion(msg.clientVersion);
        const existing =
          typeof msg.sessionId === "string" ? registry.get(msg.sessionId) : undefined;
        const afterSeq =
          existing && typeof msg.afterSeq === "number" ? msg.afterSeq : undefined;
        try {
          // fallback only when a session was actually ASKED for and is gone —
          // an id-less attach never had a transcript to lose.
          attachTo(
            existing ?? registry.create(),
            afterSeq,
            typeof msg.sessionId === "string" && !existing,
          );
        } catch (err) {
          sendError(err instanceof Error ? err.message : String(err));
        }
        break;
      }
      case "prompt":
        if (entry && typeof msg.text === "string" && msg.text.trim()) {
          // Echo the user turn through the session stream so every viewport
          // (and the replay buffer) renders the command strip.
          registry.broadcast(entry, { type: "user_prompt", text: msg.text });
          entry.session.pushPrompt(msg.text);
        }
        break;
      case "bang":
        // The `!` passthrough (4.9): run it in a PTY in the session's bang
        // cwd; the finished transcript reaches the agent as its own turn.
        if (!entry || typeof msg.command !== "string" || !msg.command.trim()) break;
        // `id` is a client-minted string (ClientMsg). Validate the RAW value —
        // String(msg.id) would coerce a missing/numeric id ("undefined", "123")
        // into something that passes the regex and launches a bang with a bad
        // correlation id.
        if (typeof msg.id !== "string" || !/^[\w-]{1,64}$/.test(msg.id)) break;
        if (entry.bang) {
          sendError("a ! command is already running (stop it first)");
          break;
        }
        // The burst throttle (finding 5) — checked only when nothing is
        // running, so the already-running refusal above keeps its message.
        // The paired bang_end keeps every viewport's grammar clean (the
        // issuer's bang bar clears, like the spawn-failure path).
        if (entry.lastBangAt !== undefined && Date.now() - entry.lastBangAt < BANG_MIN_INTERVAL_MS) {
          sendError("! commands are arriving too fast — wait a moment");
          registry.broadcast(entry, { type: "bang_end", id: msg.id, exitCode: null });
          break;
        }
        entry.lastBangAt = Date.now();
        startBang(registry, entry, msg.command, msg.id);
        break;
      case "bang_input":
        // EPHEMERAL SECRET PATH: straight to the PTY, nothing else — no
        // broadcast, no buffer, no log (a password may be in `data`).
        if (entry?.bang && entry.bang.id === msg.id && typeof msg.data === "string") {
          entry.bang.proc.write(msg.data);
        }
        break;
      case "bang_kill":
        if (entry?.bang && entry.bang.id === msg.id) entry.bang.proc.kill();
        break;
      case "ping":
        // Liveness only — answered on this connection, never buffered.
        viewport({ type: "pong" });
        break;
      case "watch_sessions":
        // This connection is the fleet page — snapshots, not a session (4.6).
        if (entry) {
          registry.detach(entry, viewport);
          entry = null;
        }
        watching = true;
        registry.watch(viewport);
        break;
      case "rename":
        if (typeof msg.sessionId === "string" && typeof msg.name === "string") {
          registry.rename(msg.sessionId, msg.name);
        }
        break;
      case "end_session":
        // Usable from a session viewport or a fleet watcher — the registry
        // tears the session down and signals any attached viewports (#11).
        if (typeof msg.sessionId === "string") {
          registry.end(msg.sessionId);
          console.log(`[${label}] end_session → ${msg.sessionId}`);
        }
        break;
      case "interrupt":
        entry?.session.interrupt();
        break;
      case "permission_response":
        if (typeof msg.id === "string" && typeof msg.allow === "boolean") {
          entry?.session.resolvePermission(msg.id, msg.allow);
        }
        break;
      case "action": {
        // Every component action is mediated here and logged (2.3).
        if (!entry || typeof msg.action !== "object" || msg.action === null) break;
        const src = typeof msg.sourceId === "string" ? msg.sourceId : "?";
        if (msg.action.kind === "prompt" && typeof msg.action.text === "string") {
          console.log(`[action] prompt from render ${src}`);
          registry.broadcast(entry, { type: "user_prompt", text: msg.action.text });
          entry.session.pushPrompt(msg.action.text);
        } else if (msg.action.kind === "tool" && typeof msg.action.name === "string") {
          const id = `action-${randomUUID().slice(0, 8)}`;
          registry.broadcast(entry, {
            type: "tool_use",
            name: msg.action.name,
            detail: `component action (${src})`,
            id,
          });
          const { output, isError } = runActionTool(
            msg.action.name,
            msg.action.args,
            entry.cwd,
          );
          registry.broadcast(entry, { type: "tool_result", output, isError, id });
        }
        // state actions never reach the server; anything else is ignored.
        break;
      }
    }
  };

  const close = () => {
    if (entry) {
      registry.detach(entry, viewport);
      console.log(`[${label}] viewport detached ← session ${entry.id}`);
    }
    if (watching) registry.unwatch(viewport);
  };

  return { handleMessage, close };
}
