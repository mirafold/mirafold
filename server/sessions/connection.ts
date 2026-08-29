import { randomUUID } from "node:crypto";
import { minInterval } from "../throttle";
import type { ConnectionContext } from "./handler-context";
import os from "node:os";
import type { AgentName, ClientMsg, WireMsg } from "../protocol";
import { PROMPT_GATE_REFUSAL, type SessionEntry, type SessionRegistry } from "./registry";
import { runActionTool } from "./actions";
import { createBangHandlers } from "./bang-handlers";
import { createFsHandlers } from "./fs-handlers";
import { createFolderPickerHandler } from "./folder-picker-handler";
import { createUploadHandlers } from "./upload-handlers";
import {
  ADAPTER_AGENTS,
  availableAgents,
  defaultAgent,
  errText,
  resolveChosenBackend,
  type Backend,
} from "../adapters";
import { relayGateRefusal } from "../provider-policy";
import type { EntitlementTokenSource } from "../relay/entitlement";
import type { EntitlementView, RelayOffReason } from "../protocol";
import {
  createSubscriptionThrottle,
  type SubscriptionActions,
} from "../relay/subscription";
import { probeLocalServers } from "../local-models";
import { createLogger } from "../log";
import { VERSION } from "../version";

// The fence-escape lives in bang-handlers.ts with the rest of the bang
// lifecycle; re-exported because the Tier-1 pin imports it from here.
export { escapeTranscriptFence } from "./bang-handlers";
import { envInt } from "../env";
import { folderPickerAvailable } from "../folder-picker";

// Minimum gap between refresh_agents-triggered probe sweeps per connection.
// The picker polls every few seconds; anything faster serves the cached
// answer instead of re-probing localhost.
const REFRESH_MIN_INTERVAL_MS = envInt("REFRESH_MIN_INTERVAL_MS", 1_000);

// How long a remote create may spend classifying its provider (engine spawn
// + catalog read) before the creator gets an honest refusal.
const VERIFY_KIND_TIMEOUT_MS = envInt("VERIFY_KIND_TIMEOUT_MS", 30_000);

// The relay refusal copy lives with the rule (provider-policy.ts
// relayGateRefusal) so the attach gate, cockpit acts, and uploads say the
// same words about the same verdict — pending-kind included.

// Agents the browser is allowed to name in the agent picker. A create message
// naming anything else falls back to the daemon default rather than erroring.
const OFFERABLE = new Set(ADAPTER_AGENTS);
const asAgent = (v: unknown): AgentName | undefined =>
  typeof v === "string" && OFFERABLE.has(v as AgentName) ? (v as AgentName) : undefined;

/** Human diagnostics for a backend choice without ever interpolating the
 * configured/discovered URL. Configured URLs can contain userinfo or signed
 * query parameters and are sensitive even when no separate key exists. */
export function describeBackendForLog(backend: Backend): string {
  const source =
    backend.endpointSource === "configured"
      ? " via configured endpoint"
      : backend.endpointSource === "discovered"
        ? " via discovered local server"
        : "";
  const model = backend.model
    ? ` (${backend.model.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 120)})`
    : "";
  return `${backend.kind}${source}${model}`;
}

export type Connection = {
  /** Feed one raw client frame (JSON text) into this viewport. */
  handleMessage: (raw: string) => void;
  /** The transport is gone — detach from whatever this viewport watched. */
  close: () => void;
};

/**
 * One viewport's server side, transport-agnostic. The local
 * WebSocket path and relay-multiplexed remote viewports share exactly this
 * logic, so to the registry a remote device is just another attached
 * viewport — same hello, same message grammar, same detach-on-close.
 */
export type ConnectionOptions = {
  label?: string;
  /** Pairing info for the "connect a device" QR. The local WS path passes
   *  it; the relay path never does — the code must not cross the relay.
   *  Same shape the hello carries (protocol.ts `agents.relay`). */
  relay?: { url: string; code: string; ws?: string };
  /** Why remote access is off, when it is (protocol.ts `agents.relayOff`).
   *  The local WS path passes it so the pair button can say so; a remote
   *  viewport is proof the relay is on and never receives it. */
  relayOff?: RelayOffReason;
  /** True for a viewport arriving over the paid relay. The relay gate
   *  refuses to attach such a viewport to a subscription-backed session;
   *  local viewports are never gated. */
  remote?: boolean;
  /** Present when this daemon runs on a license key — the manage-
   *  subscription card's backend. The local WS path passes it; billing
   *  actions never ride the relay (the key stays with the machine that holds
   *  it), so remote viewports get error replies and no hello flag. */
  subscription?: SubscriptionActions;
  /** The daemon's license-key read source: the local WS path passes it so
   *  the pair card can present on validity — the current read rides ON
   *  every hello (`agents.entitlement`); a change between hellos rides the
   *  standalone `entitlement` message. Never to a remote viewport. */
  entitlement?: Pick<EntitlementTokenSource, "state" | "onChange">;
};

export function openConnection(
  registry: SessionRegistry,
  viewport: (msg: WireMsg) => void,
  options: ConnectionOptions = {},
): Connection {
  const { label = "ws", relay, relayOff, remote = false, subscription, entitlement } = options;
  const log = createLogger(label);
  // A connection is a viewport onto one registry session — or a fleet
  // watcher observing the registry itself.
  let entry: SessionEntry | null = null;
  // A `refused` frame is the registry's word that this viewport no longer
  // belongs to its session (a mid-session credential-kind flip evicts remote
  // viewports). The registry detaches the viewport itself; what it cannot
  // reach is THIS handle — and a stale one let an evicted phone keep sending
  // `bang`/`permission_response` into a session the gate had already refused
  // (audit 2026-08-26). Same identity is registered with the registry, so
  // attach/detach/markRemote all see one function.
  // `session_ended` is the same word from the other teardown path (a stale
  // handle there let a paired phone spawn a real PTY, invisibly, after the
  // user ended the session — cold review of the same fix).
  const deliver = viewport;
  viewport = (msg) => {
    if (entry) {
      if (msg.type === "refused" && !entry.viewports.has(viewport)) entry = null;
      else if (msg.type === "session_ended" && msg.sessionId === entry.id) entry = null;
    }
    deliver(msg);
  };
  // Per-connection budget for forwarded client_error reports — the client
  // caps itself too, but a hostile client isn't bound by our bundle.
  let clientErrorReports = 0;
  let watching = false;
  let closed = false;
  // refresh_agents throttle: the picker polls on a slow interval, but a
  // hostile client could spam — bound the probe rate per connection. A
  // throttled refresh still answers, from the cache.
  const probeGate = minInterval(REFRESH_MIN_INTERVAL_MS);
  // The folder tree/Changes fs_list/fs_listdir/fs_read/fs_diff/fs_changes
  // handling, with its own per-connection throttle + git-in-flight state
  // (fs-handlers.ts). `entry` and `closed` are read through getters because
  // both change over the connection's life.
  // A viewport-scoped error reaches the terminal too — the browser may be a
  // stranger's; the terminal log is what lands in a bug report.
  const sendError = (message: string) => {
    log.error(message);
    viewport({ type: "error", message, terminal: false });
  };
  // One context for every per-connection handler factory (handler-context.ts).
  const ctx: ConnectionContext = {
    viewport,
    getEntry: () => entry,
    isClosed: () => closed,
    remote,
    sendError,
  };
  const fs = createFsHandlers(ctx);
  const folderPicker = createFolderPickerHandler(ctx);
  // File drag-and-drop staging — per-connection chunked uploads.
  const uploads = createUploadHandlers(ctx);

  // Identity first, then the replayed history, then the live stream. A
  // valid afterSeq turns the replay into a tail-only resume — the client
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
    // attach/detach cycle, so an unreaped refusal leaks the entry and its
    // engine forever, and 100 retries would exhaust MAX_SESSIONS for local
    // creates too. The important case this gate closes is a phone attaching
    // to a subscription session a local tab started.)
    const relayRefusal = remote ? relayGateRefusal(e) : undefined;
    if (relayRefusal) {
      viewport({
        type: "refused",
        reason: "subscription-relay",
        message: relayRefusal,
      });
      log.info(
        `refused remote viewport → session ${e.id} (${e.kind}${e.kindPending ? ", pending" : ""})`,
      );
      return false;
    }
    if (entry) registry.detach(entry, viewport);
    entry = e;
    const resumed = afterSeq !== undefined && registry.canResume(e, afterSeq);
    viewport({
      type: "session_created",
      sessionId: e.id,
      cwd: e.cwd,
      shellCwd: e.bangCwd,
      agent: e.agent,
      model: e.session.modelName,
      ...(resumed ? { resumed: true } : {}),
      ...(e.live ? {} : { demo: true }),
      // The caller asked for a session that no longer exists and got a
      // fresh one — the shell shows a notice instead of a silent swap.
      ...(fallback ? { fallback: true } : {}),
    });
    registry.attach(e, viewport, resumed ? afterSeq : undefined);
    // A relay viewport is governed by the relay gate even after a mid-session
    // credential-kind flip: mark it so the registry can evict it if the kind
    // becomes relay-ineligible.
    if (remote) registry.markRemote(e, viewport);
    log.info(
      `viewport ${resumed ? `resumed @${afterSeq}` : "attached"} → session ${e.id} (${e.viewports.size} viewport(s))`,
    );
    return true;
  };

  // The reap half of the relay-gate contract above: a session minted by THIS
  // message whose attach was refused has no viewports, no idle timer, and no
  // other way to die — end it on the spot.
  const attachOrReap = (e: SessionEntry, afterSeq?: number, fallback = false) => {
    if (!attachTo(e, afterSeq, fallback)) registry.end(e.id);
  };

  // Classify-before-create. A REMOTE create of an entry whose credential
  // kind is still optimistic (kindPending + a verifyBackendKind seam —
  // OpenCode) awaits the truthful classification BEFORE the relay gate
  // judges the attach, instead of refusing a race the creator can never
  // win. Local creates keep the lazy path untouched. The async detour owns
  // its errors (index.ts has no try/catch around handleMessage): a classify
  // failure or timeout errors the viewport honestly and reaps the minted
  // no-viewport entry (the leak rule above); settle re-checks entry
  // liveness and connection state before acting.
  let verifyingCreate = false;
  const attachOrReapClassified = (e: SessionEntry, afterSeq?: number, fallback = false) => {
    const verify = e.session.verifyBackendKind?.bind(e.session);
    if (!remote || !e.kindPending || !verify) {
      attachOrReap(e, afterSeq, fallback);
      return;
    }
    verifyingCreate = true;
    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          verify(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "verifying which credential backs this session took too long — " +
                      "try again, or run its first turn from its own machine",
                  ),
                ),
              VERIFY_KIND_TIMEOUT_MS,
            );
            timer.unref();
          }),
        ]);
      } catch (err) {
        verifyingCreate = false;
        if (!closed) sendError(errText(err));
        if (registry.get(e.id) === e && e.viewports.size === 0) registry.end(e.id);
        return;
      } finally {
        clearTimeout(timer);
      }
      verifyingCreate = false;
      if (registry.get(e.id) !== e) return; // torn down mid-classify
      if (closed) {
        // The creator left mid-classify; nobody owns the mint.
        if (e.viewports.size === 0) registry.end(e.id);
        return;
      }
      attachOrReap(e, afterSeq, fallback);
    })();
  };

  // Advertise which agents this daemon offers + which are live, so the
  // agent picker can render before any session exists. No agent assumed.
  // Also where the daemon was launched — the default cwd for new
  // sessions — plus home, so the client can show paths in ~-form.
  // Re-sent whole on refresh_agents — availableAgents() reads the live
  // probe cache, so a re-send after a re-probe carries newly started servers.
  // The license-key read rides ON every hello (so a client never keeps a
  // previous daemon's) and, between hellos, as its own message on change.
  const sendEntitlement = (v: EntitlementView | undefined) => {
    if (v && !remote) viewport({ type: "entitlement", ...v });
  };
  const sendAgents = () => {
    const read = remote ? undefined : entitlement?.state();
    viewport({
      type: "agents",
      agents: availableAgents(),
      default: defaultAgent(),
      cwd: process.cwd(),
      home: os.homedir(),
      folderPicker: !remote && folderPickerAvailable(),
      version: VERSION,
      ...(relay ? { relay } : {}),
      ...(relayOff && !remote ? { relayOff } : {}),
      ...(subscription && !remote ? { billing: "license-key" as const } : {}),
      ...(read ? { entitlement: read } : {}),
    });
  };
  sendAgents();
  const unsubscribeEntitlement = remote ? undefined : entitlement?.onChange(sendEntitlement);

  // The `!` lifecycle — PTY spawn, output budgets, cwd handoff, burst
  // throttle — handled per-connection in bang-handlers.ts, the fs-handlers
  // pattern.
  const bang = createBangHandlers({ ...ctx, registry });

  // The client announces its build on attach/create; a skewed pair is
  // the first thing to know about a weird bug report, so log it here.
  const noteClientVersion = (v: unknown) => {
    if (typeof v === "string" && v && v !== VERSION) {
      log.warn(`version skew: client v${v}, daemon v${VERSION}`);
    }
  };

  // The manage-subscription card's three requests. One in-flight
  // action with a floor between starts (a stuck/hostile client must not
  // hammer the billing backend), and EVERY request gets its reply — silence
  // would strand the card in "working". Remote viewports are refused here
  // too, not just denied the hello flag: the flag gates the UI, this gates
  // the action (a crafted frame is cheap; the key's actions stay local).
  const subThrottle = createSubscriptionThrottle(envInt("SUBSCRIPTION_MIN_GAP_MS", 2_000));
  const handleSubscription = (id: unknown, act: keyof SubscriptionActions) => {
    if (typeof id !== "string" || !id) return;
    const refused = !subscription
      ? "no subscription is configured on this daemon"
      : remote
        ? "manage the subscription from the desktop that holds the license key"
        : undefined;
    if (refused) {
      viewport({ type: "subscription", id, error: refused });
      return;
    }
    if (!subThrottle.tryStart()) {
      viewport({ type: "subscription", id, error: "one moment — a billing request is already in flight" });
      return;
    }
    void subscription![act]().then((r) => {
      subThrottle.done();
      if (closed) return;
      viewport(
        "view" in r
          ? { type: "subscription", id, ...r.view }
          : { type: "subscription", id, error: r.error },
      );
    });
  };

  // Resolve a cockpit act's target session: unknown id → error reply;
  // and when the act would DRIVE the model, a remote connection gets the
  // relay gate, exactly like attach. Returns undefined when refused.
  const actTarget = (sessionId: string, drivesModel: boolean): SessionEntry | undefined => {
    let target: SessionEntry | undefined;
    try {
      target = registry.open(sessionId);
    } catch (err) {
      sendError(errText(err));
      return undefined;
    }
    if (!target) {
      sendError(`no such session: ${sessionId}`);
      return undefined;
    }
    const actRefusal = drivesModel && remote ? relayGateRefusal(target) : undefined;
    if (actRefusal) {
      sendError(actRefusal);
      // `open()` may just have lazily revived a dormant engine. A refused
      // remote act owns no viewport, so return that engine to the ordinary
      // idle-unload path instead of leaving it warm indefinitely.
      registry.releaseIfUnviewed(target);
      return undefined;
    }
    return target;
  };

  const handleMessage = (raw: string) => {
    // A frame decrypted or queued across a close (the relay path awaits the
    // cipher between its liveness check and this call) must not act on a
    // session this viewport has already left.
    if (closed) return;
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
    // untouched (the ignore-unknown contract).
    if (typeof msg !== "object" || msg === null) {
      sendError("malformed client message");
      return;
    }
    switch (msg.type) {
      case "create": {
        // A bad cwd (typo'd path) rejects the create rather than silently
        // working somewhere else — the viewport stays unattached and the
        // agent-picker card shows the error.
        noteClientVersion(msg.clientVersion);
        // One classification in flight per connection — a second
        // create arriving mid-verify would interleave two mints racing one
        // `entry` slot.
        if (verifyingCreate) {
          sendError("still verifying the previous create — one moment");
          break;
        }
        // The picker's backend choice is validated HERE, against current
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
          log.info(`create → ${agent} on chosen backend ${describeBackendForLog(backend)}`);
        }
        try {
          attachOrReapClassified(
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
        // A saved id lazily reopens its provider conversation. Only a truly
        // unknown id (old bookmark / explicit end) gets the historical fresh
        // fallback; a corrupt or unavailable saved session errors in place.
        noteClientVersion(msg.clientVersion);
        if (verifyingCreate) {
          sendError("still verifying the previous create — one moment");
          break;
        }
        try {
          const existing =
            typeof msg.sessionId === "string" ? registry.open(msg.sessionId) : undefined;
          const afterSeq =
            existing && typeof msg.afterSeq === "number" ? msg.afterSeq : undefined;
          // fallback only when a session was actually ASKED for and is gone —
          // an id-less attach never had a transcript to lose. An EXISTING
          // session refused by the relay gate is left alone (a local tab may
          // own it); only a fallback-created one is reaped.
          if (existing) {
            if (!attachTo(existing, afterSeq, false)) registry.releaseIfUnviewed(existing);
          } else {
            attachOrReapClassified(registry.create(), afterSeq, typeof msg.sessionId === "string");
          }
        } catch (err) {
          sendError(errText(err));
        }
        break;
      }
      case "prompt":
        // Echo + push live in dispatchPrompt, behind the burst gate.
        if (entry && typeof msg.text === "string" && msg.text.trim()) {
          // The relay gate, re-checked at DRIVE time: a session's credential
          // kind can change mid-session (an OpenCode `/model` switch to a
          // ChatGPT or Zen provider), so the attach-time gate is not enough —
          // a remote viewport must never drive a now-subscription/gateway
          // session over the paid relay.
          const refusal = remote ? relayGateRefusal(entry) : undefined;
          if (refusal) sendError(refusal);
          else if (!registry.dispatchPrompt(entry, msg.text)) sendError(PROMPT_GATE_REFUSAL);
        }
        break;
      case "bang":
        // The `!` passthrough — PTY lifecycle, budgets, and throttle
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
        // This connection is the fleet page — snapshots, not a session.
        if (entry) {
          registry.detach(entry, viewport);
          entry = null;
        }
        watching = true;
        registry.watch(viewport);
        break;
      case "rename":
        if (typeof msg.sessionId === "string" && typeof msg.name === "string") {
          if (!registry.rename(msg.sessionId, msg.name)) {
            sendError("Could not save the session name. The previous name is unchanged.");
          }
        }
        break;
      case "end_session":
        // Usable from a session viewport or a fleet watcher — the registry
        // tears the session down and signals any attached viewports.
        if (typeof msg.sessionId === "string") {
          try {
            registry.end(msg.sessionId);
            log.info(`end_session → ${msg.sessionId}`);
          } catch (err) {
            sendError(`could not end session ${msg.sessionId}: ${errText(err)}`);
          }
        }
        break;
      // ---- Cockpit acts: sessionId-addressed like end_session, so a
      // fleet watcher acts without attaching. answer_permission's ALLOW path
      // and prompt_session DRIVE the model, so a remote (relay) connection
      // gets the same relay gate attach applies; a DENY stops the model — it
      // stays ungated (gating both would leave a phone unable to deny an ask
      // on a subscription session, resolving only by timeout), and
      // interrupt_session stays ungated like end_session. Unknown ids
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
          // An ALLOW drives the model, so a remote viewport gets the same
          // drive-time relay gate as `prompt` (a DENY stops it — ungated,
          // like answer_permission).
          const refusal = remote && msg.allow ? relayGateRefusal(entry) : undefined;
          if (refusal) {
            sendError(refusal);
            break;
          }
          // Through the registry, not the adapter directly: the answer must
          // also drop the ask from the fleet's pending queue and notify
          // watchers — same semantics as the grid's answer_permission.
          registry.answerPermission(entry.id, msg.id, msg.allow);
        }
        break;
      case "action": {
        // Every component action is mediated here and logged.
        if (!entry || typeof msg.action !== "object" || msg.action === null) break;
        const src = typeof msg.sourceId === "string" ? msg.sourceId : "?";
        if (msg.action.kind === "prompt" && typeof msg.action.text === "string") {
          // The path the burst gate exists for: the bridge reaches here with
          // no user gesture (its 400ms client-side gate is advisory). Same
          // drive-time relay re-check as the plain prompt path above.
          createLogger("action").info(`prompt from render ${src}`);
          const refusal = remote ? relayGateRefusal(entry) : undefined;
          if (refusal) sendError(refusal);
          else if (!registry.dispatchPrompt(entry, msg.action.text)) sendError(PROMPT_GATE_REFUSAL);
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
        // "start it and it appears here" promise, live. Inside the
        // throttle window the cached answer goes back instead (still a reply:
        // the client's poll must never just vanish). The async resend checks
        // `closed` — the socket may be gone by the time the probe lands.
        if (!probeGate.take()) {
          sendAgents();
          break;
        }
        void probeLocalServers().then(() => {
          if (!closed) sendAgents();
        });
        break;
      case "subscription_status":
        handleSubscription(msg.id, "status");
        break;
      case "subscription_cancel":
        handleSubscription(msg.id, "cancel");
        break;
      case "subscription_uncancel":
        handleSubscription(msg.id, "uncancel");
        break;
      case "pick_folder":
        folderPicker.pick(msg);
        break;
      case "fs_list":
        // folder tree tree/read/diff — per-viewport queries handled
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
      case "fs_changes":
        fs.changes(msg);
        break;
      case "file_upload_begin":
        // File drag-and-drop staging — chunked, capped, gated;
        // handled in upload-handlers.ts (one delegation per case, like fs_*).
        uploads.begin(msg);
        break;
      case "file_upload_chunk":
        uploads.chunk(msg);
        break;
      case "file_upload_abort":
        uploads.abort(msg);
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
    unsubscribeEntitlement?.();
    folderPicker.close();
    uploads.dispose();
    if (entry) {
      registry.detach(entry, viewport);
      log.info(`viewport detached ← session ${entry.id}`);
      entry = null;
    }
    if (watching) registry.unwatch(viewport);
  };

  return { handleMessage, close };
}
