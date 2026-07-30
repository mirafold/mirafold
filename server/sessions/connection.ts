import { randomUUID } from "node:crypto";
import os from "node:os";
import type { AgentName, ClientMsg, WireMsg } from "../protocol";
import { PROMPT_GATE_REFUSAL, type SessionEntry, type SessionRegistry } from "./registry";
import { runActionTool } from "./actions";
import { createBangHandlers } from "./bang-handlers";
import { createFsHandlers } from "./fs-handlers";
import {
  ADAPTER_AGENTS,
  availableAgents,
  defaultAgent,
  errText,
  resolveChosenBackend,
  type Backend,
} from "../adapters";
import { allowedOverRelay } from "../provider-policy";
import { probeLocalServers } from "../local-models";
import { createLogger } from "../log";
import { VERSION } from "../version";

// The fence-escape lives in bang-handlers.ts with the rest of the bang
// lifecycle; re-exported because the Tier-1 pin imports it from here.
export { escapeTranscriptFence } from "./bang-handlers";
import { envInt } from "../env";

// Minimum gap between refresh_agents-triggered probe sweeps per connection
// (N.3). The picker polls every few seconds; anything faster serves the
// cached answer instead of re-probing localhost.
const REFRESH_MIN_INTERVAL_MS = envInt("REFRESH_MIN_INTERVAL_MS", 1_000);

// What a remote (relay) connection is told when a cockpit act would drive a
// subscription-backed session (M.2) — the same reasoning as the attach gate's
// refusal (R.4i), phrased for an action instead of an attach.
const RELAY_GATE_REFUSAL =
  "This session runs on a subscription login, which can't be driven over the relay. " +
  "Use an API key to drive an agent remotely.";

// Agents the browser is allowed to name at onboarding (P.4). A create message
// naming anything else falls back to the daemon default rather than erroring.
const OFFERABLE = new Set(ADAPTER_AGENTS);
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
  // Same shape the hello carries (protocol.ts `agents.relay`).
  relay?: { url: string; code: string; ws?: string },
  // True for a viewport arriving over the paid relay (relay-client passes
  // it). The relay gate refuses to attach such a viewport to a subscription-
  // backed session; local viewports are never gated (R.4i).
  remote = false,
): Connection {
  const log = createLogger(label);
  // A connection is a viewport onto one registry session (Step 4.2) — or,
  // since 4.6, a fleet watcher observing the registry itself.
  let entry: SessionEntry | null = null;
  // Per-connection budget for forwarded client_error reports — the client
  // caps itself too, but a hostile client isn't bound by our bundle.
  let clientErrorReports = 0;
  let watching = false;
  let closed = false;
  // refresh_agents throttle (N.3): the picker polls on a slow interval, but a
  // hostile client could spam — bound the probe rate per connection. A
  // throttled refresh still answers, from the cache.
  let lastProbeAt = 0;
  // The Explorer's fs_list/fs_listdir/fs_read/fs_diff handling (Phase E), with its own
  // per-connection throttle + git-in-flight state (fs-handlers.ts). `entry`
  // and `closed` are read through getters because both change over the
  // connection's life.
  const fs = createFsHandlers({
    viewport,
    getEntry: () => entry,
    isClosed: () => closed,
  });

  // Identity first, then the replayed history, then the live stream. 4.4:
  // a valid afterSeq turns the replay into a tail-only resume — the client
  // is told via `resumed` so it keeps its state instead of repainting.
  // Returns false on a relay-gate refusal so create-ish callers can reap the
  // session they just minted (see below); true once the viewport is attached.
  const attachTo = (e: SessionEntry, afterSeq?: number, fallback = false): boolean => {
    // The relay gate. A remote viewport may not drive a subscription-
    // backed session — charging for remote access to it trips the closed-model
    // providers' reselling clauses (provider-policy.ts). Refuse WITHOUT
    // attaching, and leave `entry` as it was so the viewport keeps whatever it
    // legitimately watched. Local viewports are never gated. (A remote CREATE
    // that lands here has just minted a session no one is attached to — the
    // CALLER must reap it: nothing arms the idle timer before a first
    // attach/detach cycle, so an unreaped refusal leaked the entry and its
    // engine forever, and 100 retries exhausted MAX_SESSIONS for local
    // creates too — 2026-07-29 bughunt. The important case this gate closes
    // is a phone attaching to a subscription session a local tab started.)
    // (R.4i)
    if (remote && !allowedOverRelay(e.kind)) {
      viewport({
        type: "refused",
        reason: "subscription-relay",
        message:
          "This session runs on a subscription login, which can't be used over the relay. Use an API key to drive an agent remotely.",
      });
      log.info(`refused remote viewport → session ${e.id} (${e.kind})`);
      return false;
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
    log.info(
      `viewport ${resumed ? `resumed @${afterSeq}` : "attached"} → session ${e.id} (${e.viewports.size} viewport(s))`,
    );
    return true;
  };

  // The reap half of the relay-gate contract above: a session minted by THIS
  // message whose attach was refused has no viewports, no idle timer, and no
  // other way to die — end it on the spot (2026-07-29 bughunt).
  const attachOrReap = (e: SessionEntry, afterSeq?: number, fallback = false) => {
    if (!attachTo(e, afterSeq, fallback)) registry.end(e.id);
  };

  // Advertise which agents this daemon offers + which are live, so the
  // onboarding picker can render before any session exists. No agent assumed (P.4).
  // Also where the daemon was launched — the default cwd for new
  // sessions — plus home, so the client can show paths in ~-form (4.8).
  // Re-sent whole on refresh_agents (N.3) — availableAgents() reads the live
  // probe cache, so a re-send after a re-probe carries newly started servers.
  const sendAgents = () =>
    viewport({
      type: "agents",
      agents: availableAgents(),
      default: defaultAgent(),
      cwd: process.cwd(),
      home: os.homedir(),
      version: VERSION,
      ...(relay ? { relay } : {}),
    });
  sendAgents();

  // A viewport-scoped error reaches the terminal too — the browser may
  // be a stranger's; the terminal log is what lands in a bug report (R.4g).
  const sendError = (message: string) => {
    log.error(message);
    viewport({ type: "error", message });
  };

  // The `!` lifecycle (4.9) — PTY spawn, output budgets, cwd handoff, burst
  // throttle — handled per-connection in bang-handlers.ts, the fs-handlers
  // pattern.
  const bang = createBangHandlers({ registry, getEntry: () => entry, sendError, viewport });

  // The client announces its build on attach/create; a skewed pair is
  // the first thing to know about a weird bug report, so log it here (R.4g).
  const noteClientVersion = (v: unknown) => {
    if (typeof v === "string" && v && v !== VERSION) {
      log.warn(`version skew: client v${v}, daemon v${VERSION}`);
    }
  };

  // Resolve a cockpit act's target session (M.2): unknown id → error reply;
  // and when the act would DRIVE the model, a remote connection gets the
  // R.4i gate, exactly like attach. Returns undefined when refused.
  const actTarget = (sessionId: string, drivesModel: boolean): SessionEntry | undefined => {
    const target = registry.get(sessionId);
    if (!target) {
      sendError(`no such session: ${sessionId}`);
      return undefined;
    }
    if (drivesModel && remote && !allowedOverRelay(target.kind)) {
      sendError(RELAY_GATE_REFUSAL);
      return undefined;
    }
    return target;
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
      case "create": {
        // A bad cwd (typo'd path) rejects the create rather than silently
        // working somewhere else — the viewport stays unattached and the
        // onboarding card shows the error (Step 4.8).
        noteClientVersion(msg.clientVersion);
        // N.5: the picker's backend choice is validated HERE, against current
        // detection + provider policy — never trusted. A refused choice is a
        // create error (the picker shows it); honoring it only with a valid
        // agent keeps a choice from riding an unknown-agent fallback.
        const agent = asAgent(msg.agent);
        let backend: Backend | undefined;
        if (agent && msg.backend !== undefined) {
          const resolved = resolveChosenBackend(agent, msg.backend);
          if ("error" in resolved) {
            sendError(resolved.error);
            break;
          }
          backend = resolved;
          log.info(
            `create → ${agent} on chosen backend ${backend.kind}` +
              (backend.endpoint ? ` @ ${backend.endpoint}` : "") +
              (backend.model ? ` (${backend.model})` : ""),
          );
        }
        try {
          attachOrReap(
            registry.create({
              cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
              agent,
              backend,
            }),
          );
        } catch (err) {
          sendError(errText(err));
        }
        break;
      }
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
          // an id-less attach never had a transcript to lose. An EXISTING
          // session refused by the relay gate is left alone (a local tab may
          // own it); only a fallback-created one is reaped.
          if (existing) {
            attachTo(existing, afterSeq, false);
          } else {
            attachOrReap(registry.create(), afterSeq, typeof msg.sessionId === "string");
          }
        } catch (err) {
          sendError(errText(err));
        }
        break;
      }
      case "prompt":
        // Echo + push live in dispatchPrompt, behind the burst gate.
        if (entry && typeof msg.text === "string" && msg.text.trim()) {
          if (!registry.dispatchPrompt(entry, msg.text)) sendError(PROMPT_GATE_REFUSAL);
        }
        break;
      case "bang":
        // The `!` passthrough (4.9) — PTY lifecycle, budgets, and throttle
        // handled in bang-handlers.ts (one delegation per case, like fs_*).
        bang.start(msg);
        break;
      case "bang_input":
        bang.input(msg);
        break;
      case "bang_kill":
        bang.kill(msg);
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
          log.info(`end_session → ${msg.sessionId}`);
        }
        break;
      // ---- Cockpit acts (M.2): sessionId-addressed like end_session, so a
      // fleet watcher acts without attaching. answer_permission's ALLOW path
      // and prompt_session DRIVE the model, so a remote (relay) connection
      // gets the same R.4i gate attach applies; a DENY stops the model — it
      // stays ungated (2026-07-28 fix: gating both left a phone unable to
      // deny an ask on a subscription session, resolving only by timeout),
      // and interrupt_session stays ungated like end_session. Unknown ids
      // error, never crash.
      case "answer_permission": {
        if (
          typeof msg.sessionId !== "string" ||
          typeof msg.id !== "string" ||
          typeof msg.allow !== "boolean"
        ) {
          break;
        }
        if (!actTarget(msg.sessionId, msg.allow)) break;
        registry.answerPermission(msg.sessionId, msg.id, msg.allow);
        log.info(`answer_permission → session ${msg.sessionId} (${msg.allow ? "allow" : "deny"})`);
        break;
      }
      case "interrupt_session":
        if (typeof msg.sessionId === "string") {
          if (registry.interruptSession(msg.sessionId)) {
            log.info(`interrupt_session → ${msg.sessionId}`);
          } else {
            sendError(`no such session: ${msg.sessionId}`);
          }
        }
        break;
      case "prompt_session": {
        if (typeof msg.sessionId !== "string" || typeof msg.text !== "string") break;
        const text = msg.text.trim();
        // The frame cap already bounds a message; this bounds what one grid
        // dispatch may push into a model turn.
        if (!text || text.length > 100_000) break;
        const target = actTarget(msg.sessionId, true);
        if (!target) break;
        if (!registry.dispatchPrompt(target, text)) {
          sendError(PROMPT_GATE_REFUSAL);
          break;
        }
        log.info(`prompt_session → session ${msg.sessionId}`);
        break;
      }
      case "interrupt":
        entry?.session.interrupt();
        break;
      case "permission_response":
        if (typeof msg.id === "string" && typeof msg.allow === "boolean" && entry) {
          // Through the registry, not the adapter directly: the answer must
          // also drop the ask from the fleet's pending queue and notify
          // watchers — same semantics as the grid's answer_permission.
          registry.answerPermission(entry.id, msg.id, msg.allow);
        }
        break;
      case "action": {
        // Every component action is mediated here and logged (2.3).
        if (!entry || typeof msg.action !== "object" || msg.action === null) break;
        const src = typeof msg.sourceId === "string" ? msg.sourceId : "?";
        if (msg.action.kind === "prompt" && typeof msg.action.text === "string") {
          // The path the burst gate exists for: the bridge reaches here with
          // no user gesture (its 400ms client-side gate is advisory).
          createLogger("action").info(`prompt from render ${src}`);
          if (!registry.dispatchPrompt(entry, msg.action.text)) sendError(PROMPT_GATE_REFUSAL);
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
      case "refresh_agents":
        // Re-probe local model servers, then re-send the hello — the picker's
        // "start it and it appears here" promise, live (N.3). Inside the
        // throttle window the cached answer goes back instead (still a reply:
        // the client's poll must never just vanish). The async resend checks
        // `closed` — the socket may be gone by the time the probe lands.
        if (Date.now() - lastProbeAt < REFRESH_MIN_INTERVAL_MS) {
          sendAgents();
          break;
        }
        lastProbeAt = Date.now();
        void probeLocalServers().then(() => {
          if (!closed) sendAgents();
        });
        break;
      case "fs_list":
        // Explorer tree/read/diff (Phase E) — per-viewport queries handled
        // in fs-handlers.ts (jail, throttle, git-in-flight, one reply each).
        fs.list(msg);
        break;
      case "fs_listdir":
        fs.listdir(msg);
        break;
      case "fs_read":
        fs.read(msg);
        break;
      case "fs_diff":
        fs.diff(msg);
        break;
      case "client_error":
        // The browser half's uncaught errors, landing in the flight-recorder
        // log so a front-end crash leaves a trace a bug report can attach.
        // Untrusted text: type-checked, clipped, counted — logged and nothing
        // else (never broadcast, never echoed into any surface).
        if (typeof msg.message === "string" && ++clientErrorReports <= 20) {
          const skew =
            typeof msg.clientVersion === "string" && msg.clientVersion !== VERSION
              ? ` (client v${msg.clientVersion})`
              : "";
          log.error(`client error${skew}: ${msg.message.slice(0, 2_000)}`);
        }
        break;
    }
  };

  const close = () => {
    closed = true;
    if (entry) {
      registry.detach(entry, viewport);
      log.info(`viewport detached ← session ${entry.id}`);
    }
    if (watching) registry.unwatch(viewport);
  };

  return { handleMessage, close };
}
