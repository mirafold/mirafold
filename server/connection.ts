import { randomUUID } from "node:crypto";
import os from "node:os";
import type { AgentName, ClientMsg, WireMsg } from "./protocol";
import type { SessionEntry, SessionRegistry } from "./registry";
import { runActionTool } from "./actions";
import { availableAgents, defaultAgent } from "./adapters";
import { spawnBang } from "./pty";

// How much of a `!` command's output rides into the agent's context with the
// next prompt (tail-kept — the end of a long output is usually the payload).
// The wire/replay stream is never capped by this; it only bounds the context
// injection so one verbose command can't eat the model's window.
const BANG_CONTEXT_CAP = Number(process.env.BANG_CONTEXT_CAP ?? 16_000);

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
  const attachTo = (e: SessionEntry, afterSeq?: number) => {
    if (entry) registry.detach(entry, viewport);
    entry = e;
    const resumed = afterSeq !== undefined && registry.canResume(e, afterSeq);
    viewport({
      type: "session_created",
      sessionId: e.id,
      cwd: e.cwd,
      agent: e.agent,
      ...(resumed ? { resumed: true } : {}),
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
    ...(relay ? { relay } : {}),
  });

  const handleMessage = (raw: string) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      viewport({ type: "error", message: "malformed client message" });
      return;
    }
    switch (msg.type) {
      case "create":
        // A bad cwd (typo'd path) rejects the create rather than silently
        // working somewhere else — the viewport stays unattached and the
        // onboarding card shows the error (Step 4.8).
        try {
          attachTo(
            registry.create({
              cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
              agent: asAgent(msg.agent),
            }),
          );
        } catch (err) {
          viewport({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
        break;
      case "attach": {
        // A stale/unknown id (old bookmark, server restart) gets a fresh
        // session rather than an error page — unless the session cap rejects
        // the fallback create, which surfaces as an error (not a crash).
        const existing =
          typeof msg.sessionId === "string" ? registry.get(msg.sessionId) : undefined;
        const afterSeq =
          existing && typeof msg.afterSeq === "number" ? msg.afterSeq : undefined;
        try {
          attachTo(existing ?? registry.create(), afterSeq);
        } catch (err) {
          viewport({ type: "error", message: err instanceof Error ? err.message : String(err) });
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
      case "bang": {
        // The `!` passthrough (4.9): run it in a PTY in the session's cwd —
        // instant, zero tokens, never routed through the model.
        if (!entry || typeof msg.command !== "string" || !msg.command.trim()) break;
        if (!/^[\w-]{1,64}$/.test(String(msg.id))) break;
        if (entry.bang) {
          viewport({ type: "error", message: "a ! command is already running (stop it first)" });
          break;
        }
        const e = entry;
        const { command, id } = msg;
        // Tail-kept accumulator, capped as data arrives — a long-running
        // command (`!yes`) must not grow server memory until exit.
        let output = "";
        let elided = 0;
        registry.broadcast(e, { type: "bang_start", command, id });
        const proc = spawnBang(
          command,
          e.cwd,
          (data) => {
            output += data;
            if (output.length > BANG_CONTEXT_CAP) {
              elided += output.length - BANG_CONTEXT_CAP;
              output = output.slice(-BANG_CONTEXT_CAP);
            }
            registry.broadcast(e, { type: "bang_output", data, id });
          },
          (exitCode) => {
            e.bang = undefined;
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
        break;
      }
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
