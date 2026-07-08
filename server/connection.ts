import { randomUUID } from "node:crypto";
import os from "node:os";
import type { AgentName, ClientMsg, WireMsg } from "./protocol";
import type { SessionEntry, SessionRegistry } from "./registry";
import { runActionTool } from "./actions";
import { availableAgents, defaultAgent } from "./adapters";
import { spawnBang } from "./pty";
import { VERSION } from "./version";

// How much of a `!` command's output rides into the agent's context with the
// next prompt (tail-kept — the end of a long output is usually the payload).
// The wire/replay stream is never capped by this; it only bounds the context
// injection so one verbose command can't eat the model's window.
const BANG_CONTEXT_CAP = Number(process.env.BANG_CONTEXT_CAP ?? 16_000);

// R.4d: how much of a `!` command's output reaches the wire — and therefore
// the replay ring — per command (head-kept, honest marker; mirrors the
// TOOL_OUTPUT_CAP_BYTES pattern). Without it one runaway `!yes` floods every
// viewport, is replayed in full to each new tab, and its chunks evict the
// real transcript from the ring. The PTY keeps running past the cap and the
// agent-context tail above keeps accumulating — only the broadcast stops.
const BANG_OUTPUT_CAP_BYTES = Number(process.env.BANG_OUTPUT_CAP_BYTES ?? 262_144);

/**
 * Step 4.9: prompts carry any finished-since-last-turn `!` transcripts as
 * leading context — terminal-faithful (the model sees what you ran), and
 * agent-neutral: it consumes only the AgentSession seam's pushPrompt, so
 * every engine gets it without per-adapter code. The user_prompt broadcast
 * stays the raw typed text; only the engine sees the injected block.
 */
const pushWithBangContext = (entry: SessionEntry, text: string) => {
  const blocks = entry.pendingBang.splice(0);
  entry.session.pushPrompt(
    blocks.length ? `${blocks.join("\n")}\n${text}` : text,
  );
};

/**
 * Step 4.9: run one `!` command in the session's PTY and drive its whole
 * lifecycle — the bang_start/…/bang_end grammar, the head-kept wire budget
 * (what viewports and the replay ring see, R.4d), and the tail-kept context
 * accumulator that rides into the agent's next prompt.
 */
const startBang = (registry: SessionRegistry, e: SessionEntry, command: string, id: string) => {
  // Tail-kept accumulator, capped as data arrives — a long-running
  // command (`!yes`) must not grow server memory until exit.
  let output = "";
  let elided = 0;
  // R.4d: per-command wire budget (bytes broadcast / bytes withheld).
  let wireSent = 0;
  let wireElided = 0;
  registry.broadcast(e, { type: "bang_start", command, id });
  try {
    const proc = spawnBang(
      command,
      e.cwd,
      (data) => {
        output += data;
        if (output.length > BANG_CONTEXT_CAP) {
          elided += output.length - BANG_CONTEXT_CAP;
          output = output.slice(-BANG_CONTEXT_CAP);
        }
        // R.4d: head-kept wire cap. Past it nothing is broadcast (so
        // nothing enters the ring); the marker announces the cut the
        // moment it happens, and the exit path reports the total.
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
        // Queue the transcript for the agent's next turn. Tail-kept cap;
        // echo-off input (passwords) was never in the PTY output, so it
        // can't leak into context here either.
        const tail = elided > 0 ? `(… ${elided} chars elided …)\n` + output : output;
        e.pendingBang.push(
          `<bash-input>${command}</bash-input>\n<bash-output exit-code="${exitCode ?? "killed"}">\n${tail}</bash-output>`,
        );
      },
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
  // R.4: pairing info for the "connect a device" QR. The local WS path passes
  // it; the relay path never does — the code must not cross the relay.
  relay?: { url: string; code: string },
): Connection {
  // A connection is a viewport onto one registry session (Step 4.2) — or,
  // since 4.6, a fleet watcher observing the registry itself.
  let entry: SessionEntry | null = null;
  let watching = false;

  // Identity first, then the replayed history, then the live stream. 4.4:
  // a valid afterSeq turns the replay into a tail-only resume — the client
  // is told via `resumed` so it keeps its state instead of repainting.
  const attachTo = (e: SessionEntry, afterSeq?: number, fallback = false) => {
    if (entry) registry.detach(entry, viewport);
    entry = e;
    const resumed = afterSeq !== undefined && registry.canResume(e, afterSeq);
    viewport({
      type: "session_created",
      sessionId: e.id,
      cwd: e.cwd,
      agent: e.agent,
      ...(resumed ? { resumed: true } : {}),
      ...(e.live ? {} : { demo: true }),
      // R.4c: the caller asked for a session that no longer exists and got a
      // fresh one — the shell shows a notice instead of a silent swap.
      ...(fallback ? { fallback: true } : {}),
    });
    registry.attach(e, viewport, resumed ? afterSeq : undefined);
    console.log(
      `[${label}] viewport ${resumed ? `resumed @${afterSeq}` : "attached"} → session ${e.id} (${e.viewports.size} viewport(s))`,
    );
  };

  // P.4: advertise which agents this daemon offers + which are live, so the
  // onboarding picker can render before any session exists. No agent assumed.
  // 4.8: also where the daemon was launched — the default cwd for new
  // sessions — plus home, so the client can show paths in ~-form.
  viewport({
    type: "agents",
    agents: availableAgents(),
    default: defaultAgent(),
    cwd: process.cwd(),
    home: os.homedir(),
    version: VERSION,
    ...(relay ? { relay } : {}),
  });

  // R.4g: a viewport-scoped error reaches the terminal too — the browser may
  // be a stranger's; the terminal log is what lands in a bug report.
  const sendError = (message: string) => {
    console.error(`[${new Date().toISOString()}] [${label}] error: ${message}`);
    viewport({ type: "error", message });
  };

  // R.4g: the client announces its build on attach/create; a skewed pair is
  // the first thing to know about a weird bug report, so log it here.
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
          pushWithBangContext(entry, msg.text);
        }
        break;
      case "bang":
        // The `!` passthrough (4.9): run it in a PTY in the session's cwd —
        // instant, zero tokens, never routed through the model.
        if (!entry || typeof msg.command !== "string" || !msg.command.trim()) break;
        if (!/^[\w-]{1,64}$/.test(String(msg.id))) break;
        if (entry.bang) {
          sendError("a ! command is already running (stop it first)");
          break;
        }
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
        // 4.6: this connection is the fleet page — snapshots, not a session.
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
      case "interrupt":
        entry?.session.interrupt();
        break;
      case "permission_response":
        if (typeof msg.id === "string" && typeof msg.allow === "boolean") {
          entry?.session.resolvePermission(msg.id, msg.allow);
        }
        break;
      case "action": {
        // Step 2.3: every component action is mediated here and logged.
        if (!entry || typeof msg.action !== "object" || msg.action === null) break;
        const src = typeof msg.sourceId === "string" ? msg.sourceId : "?";
        if (msg.action.kind === "prompt" && typeof msg.action.text === "string") {
          console.log(`[action] prompt from render ${src}`);
          registry.broadcast(entry, { type: "user_prompt", text: msg.action.text });
          pushWithBangContext(entry, msg.action.text);
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
