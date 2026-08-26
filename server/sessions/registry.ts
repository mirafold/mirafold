import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PromptOption, SessionMeta, SessionMsg, WireMsg } from "../protocol";
import {
  createSession,
  errText,
  resolveBackend,
  resolveBackendFor,
  restoreBackend,
  type AgentName,
  type AgentSession,
  type Backend,
} from "../adapters";
import { allowedOverRelay, relayGateRefusal, type CredentialKind } from "../provider-policy";
import type { BangProc } from "../pty/pty";
import { createLogger, scrub, verbose } from "../log";
import { startWatch, type FsWatchHandle } from "./fs-watch";
import { invalidateRepoStatusCache } from "./git";
import { envInt } from "../env";
import { recoverStoredTranscript } from "./session-recovery";
import { SessionCheckpointStore, admitForCheckpoint, type StoredSession } from "./session-store";
import { normalizePromptOptions } from "../prompt-options";

import { ReplayRing } from "./replay-ring";
import {
  IDLE_STATE,
  reduceSessionState,
  type SessionActivityState,
  type SessionStateInput,
} from "./session-state";

export { foldUsage } from "./session-state";

// A session with no viewports keeps a warm engine this long. With the
// production checkpoint store it then unloads to a dormant resumable record;
// registries without a store (focused tests) retain the historical teardown.
const IDLE_TIMEOUT_MS = envInt("SESSION_IDLE_TIMEOUT_MS", 4 * 60 * 60_000);
// The one refusal line for a prompt the burst gate rejects (dispatchPrompt) —
// shared so every path (prompt, grid dispatch, component action) refuses
// identically.
export const PROMPT_GATE_REFUSAL =
  "a turn is already running and a prompt is queued — wait for the turn to end";
// Streamed deltas are merged inside this window before they enter the
// session stream: one broadcast WireMsg whose text is the concatenation of
// the merged deltas — the replay ring, local viewports, and the relay's
// sealed frames all carry the merged message, and byte accounting sees only
// what was actually buffered. Any OTHER message flushes the window first, so
// the stream keeps the adapter's exact order. 33ms holds a couple of mock
// chunks per flush (12–14ms pacing), so demo streaming still reads as a
// stream. 0 disables merging — every delta passes straight through
// synchronously; tests inject their own window via the constructor.
const DELTA_COALESCE_MS = envInt("DELTA_COALESCE_MS", 33);
// Ceiling on concurrent sessions: a runaway or hostile local client can't
// exhaust memory + PTYs by creating without bound. Generous — a human working
// across projects won't approach it; create() throws past it (the caller turns
// that into an error WireMsg). Env-overridable.
const MAX_SESSIONS = envInt("MAX_SESSIONS", 100);
// Ceiling on the short ENGINE-SUPPLIED labels the shell renders as chrome:
// tool names (`status.label`, `tool_use.name`) and the model label. None has
// a length bound at its source — they come from `system/init`, the Codex
// rollout file, Gemini stats, and (the realistic path) any third-party MCP
// server the user installed, whose tool names pass through verbatim. Real
// values are a few dozen chars; a 200 KB one makes the whole PAGE scroll
// sideways because the activity indicator lives in prompt-area chrome, where
// growth widens the layout instead of a scroll box. Capped HERE — one choke
// point covers every adapter at once — and the line also ellipsizes in CSS.
// Bloat insurance, not an escape guard: React already renders a hostile
// string inert.
const LABEL_CAP = 120;
const capLabel = (s: string) => (s.length > LABEL_CAP ? s.slice(0, LABEL_CAP) + "…" : s);
// A permission ask's detail is what the user decides ON, so it is never
// scrubbed (a redacted command is not the command that runs) — but it IS
// bounded: an engine-authored detail otherwise rides the wire, the fleet
// mirror, and the checkpoint at any size. Generous, because a real multi-line
// script must stay readable; the marker makes the cut honest (2026-08-26).
const DETAIL_CAP = 16_000;
// After the caps below, every message is judged by the checkpoint decoder's
// own schemas (session-store.ts admitForCheckpoint): an engine-authored value
// the decoder would refuse — an overlong id, a NaN token count, an array
// where a record is due — used to checkpoint fine and make the WHOLE session
// unrestorable at the next start. Coerced where a legitimate reading exists,
// dropped otherwise (an ask that never shows denies at its timeout).
const capDetail = (s: string) =>
  s.length > DETAIL_CAP ? s.slice(0, DETAIL_CAP) + `\n(… ${s.length - DETAIL_CAP} more characters withheld …)` : s;

/** Bound engine-supplied shell metadata and scrub credential-bearing provider
 * errors before wire/checkpoint/log fanout. Returns the same object on the
 * common no-change path. */
function normalizeWireMetadata(msg: SessionMsg): SessionMsg | undefined {
  return admitForCheckpoint(capWireMetadata(msg));
}

function capWireMetadata(msg: SessionMsg): SessionMsg {
  if (msg.type === "prompt_options") {
    return { ...msg, options: normalizePromptOptions(msg.options) };
  }
  if (msg.type === "status") {
    if (msg.label === undefined || msg.label.length <= LABEL_CAP) return msg;
    return { ...msg, label: capLabel(msg.label) };
  }
  if (msg.type === "tool_use") {
    if (msg.name.length <= LABEL_CAP) return msg;
    return { ...msg, name: capLabel(msg.name) };
  }
  if (msg.type === "usage") {
    if (msg.model === undefined || msg.model.length <= LABEL_CAP) return msg;
    return { ...msg, model: capLabel(msg.model) };
  }
  if (msg.type === "permission_request") {
    const tool = capLabel(msg.tool);
    const detail = capDetail(msg.detail);
    return tool === msg.tool && detail === msg.detail ? msg : { ...msg, tool, detail };
  }
  if (msg.type === "error") {
    const message = scrub(msg.message);
    return message === msg.message ? msg : { ...msg, message };
  }
  if (msg.type === "notice" && msg.source) {
    const text = scrub(msg.text);
    return text === msg.text ? msg : { ...msg, text };
  }
  return msg;
}

export type Viewport = (msg: WireMsg) => void;

/**
 * A user-chosen working dir behaves like `cd`: `~` expands, the path must
 * already exist and be a directory, and a bad path throws (the caller turns
 * it into an error WireMsg). No path → the daemon's own launch dir.
 */
export function resolveCwd(cwd?: string): string {
  if (!cwd) return process.cwd();
  const expanded = expandHomePath(cwd);
  const dir = path.resolve(expanded);
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new Error(`no such directory: ${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`not a directory: ${dir}`);
  return dir;
}

/** Expand terminal-style home syntax without assuming the host separator.
 * The optional home makes Windows-shaped behavior testable on every runner. */
export function expandHomePath(cwd: string, home = os.homedir()): string {
  return cwd.replace(/^~(?=[\\/]|$)/, home);
}

export type SessionEntry = SessionActivityState & {
  id: string;
  cwd: string;
  // Where the next `!` command runs. `cd` in a bang persists here, confined
  // to cwd and its children (the escape guard in connection.ts resets it) —
  // cwd itself stays the immutable workspace root for everything else.
  bangCwd: string;
  agent: AgentName;
  // False ⇒ the agent had no credentials and `session` is the scripted
  // mock — carried to the shell as session_created.demo so the banner draws.
  live: boolean;
  // The credential kind behind this session — read by the relay gate in
  // connection.ts to refuse a subscription-backed session over the paid relay.
  kind: CredentialKind;
  // True while `kind` is the hello-time OPTIMISTIC answer for an adapter
  // that can only classify truthfully once its engine starts (OpenCode).
  // The relay gate refuses remote actions outright until the session's
  // onBackendKind publish clears it — provider-policy.ts relayGateRefusal.
  kindPending?: boolean;
  // Exact server-side backend selection, persisted so recovery cannot silently
  // move the conversation to a different credential/provider/model server.
  // A configured endpoint URL can itself be sensitive; it never rides the wire.
  backend: Backend;
  session: AgentSession;
  promptOptions: PromptOption[];
  /** The sequenced replay ring plus the delta-coalescing window that feeds
   *  it; delivers into `deliver()` in exact stream order. */
  ring: ReplayRing;
  viewports: Set<Viewport>;
  // The subset of `viewports` that are REMOTE (relay) — the ones the relay
  // gate governs. Tracked so a mid-session credential-kind flip to a
  // relay-ineligible kind (an OpenCode `/model` switch) can detach them, the
  // same posture the attach gate takes for a fresh remote attach. Always a
  // subset of `viewports`.
  remoteViewports: Set<Viewport>;
  // Fleet metadata: display name (defaults to the cwd leaf, renamable) and
  // when the stream last moved. The stream-derived state (status, turn
  // counters, activity, pending asks, usage) is the SessionActivityState
  // this type extends — session-state.ts owns the rule.
  name: string;
  lastActivity: number;
  idleTimer?: NodeJS.Timeout;
  // The one running `!` command, if any (one at a time per session,
  // like a terminal). The proc itself never leaves the server.
  bang?: { id: string; proc: BangProc; silent: boolean };
  // When the last `!` command started — the burst throttle in connection.ts
  // (each bang costs a model turn, so bursts burn tokens).
  lastBangAt?: number;
  // The live-tree doorbell: running exactly while viewports are attached —
  // first attach starts it, last detach (and end) stops it — so a dormant
  // session holds no inotify watches.
  fsWatch?: FsWatchHandle;
  // When the session was created — the cockpit's stable sort key.
  createdAt: number;
  checkpointTimer?: NodeJS.Timeout;
};


export type RegistryOptions = {
  /** The daemon-default backend for a create() that names no agent. */
  backend?: Backend;
  /** The delta-merge window; 0 = no merging (tests that drive broadcast()
   *  by hand and inspect state between calls pass 0). */
  deltaCoalesceMs?: number;
  store?: SessionCheckpointStore;
  idleTimeoutMs?: number;
  /** Test seam: the classify-before-create flow needs an entry whose session
   *  exposes onBackendKind/verifyBackendKind without spawning a real engine. */
  makeSession?: typeof createSession;
};

/**
 * Sessions decoupled from connections. A session outlives any
 * socket: connections attach as viewports, every emitted WireMsg is fanned
 * out to all of them and kept in a ring buffer that replays on attach, and
 * closing a tab merely detaches. Idle timeout unloads a warm engine to its
 * durable dormant record; explicit End Session removes the conversation.
 * Mental model: session ≈ project — each gets its own working dir.
 */
export class SessionRegistry {
  private entries = new Map<string, SessionEntry>();
  private dormant = new Map<string, StoredSession>();
  private restoreErrors = new Map<string, string>();

  // Which agent every session in this registry runs, resolved once from
  // config. The agent is chosen here, not hardcoded downstream.
  private backend: Backend;
  private deltaCoalesceMs: number;
  private store?: SessionCheckpointStore;
  private idleTimeoutMs: number;
  private makeSession: typeof createSession;

  constructor(options: RegistryOptions = {}) {
    this.backend = options.backend ?? resolveBackend();
    this.deltaCoalesceMs = options.deltaCoalesceMs ?? DELTA_COALESCE_MS;
    this.store = options.store;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.makeSession = options.makeSession ?? createSession;
    if (this.store) {
      const loaded = this.store.loadAll();
      this.dormant = loaded.sessions;
      this.restoreErrors = loaded.errors;
    }
  }

  create(opts?: { cwd?: string; agent?: AgentName; backend?: Backend }): SessionEntry {
    if (this.entries.size + this.dormant.size >= MAX_SESSIONS) {
      throw new Error(`session limit reached (${MAX_SESSIONS})`);
    }
    const id = randomUUID().slice(0, 8);
    // Which agent this session runs: the caller's choice in the agent picker,
    // resolved to a fresh backend here; no choice → the daemon default. Secrets
    // stay server-side — the client only ever names the agent. A chosen
    // backend arrives PRE-VALIDATED (connection.ts ran resolveChosenBackend —
    // this registry never sees raw client input) and wins over precedence.
    const backend =
      opts?.backend ?? (opts?.agent ? resolveBackendFor(opts.agent) : this.backend);
    // cwd is whatever the caller chose; the default is the directory the
    // daemon was launched from — the terminal's own model. Any dir is fair
    // game — safe because the socket binds to loopback (server/index.ts), so
    // only local-you can pick it, exactly as with the terminal; loopback
    // already closes the remote-cwd vector, so no jail is needed. A chosen
    // dir must already exist — `cd`, not `mkdir -p` — so a typo errors
    // instead of silently creating and working in a stray directory.
    const dir = resolveCwd(opts?.cwd);
    // The configured agent becomes a concrete engine at this one seam.
    // Falls back to the mock when the agent has no credentials.
    const session: AgentSession = this.makeSession(backend, { cwd: dir });
    const entry: SessionEntry = {
      ...IDLE_STATE,
      id,
      cwd: dir,
      bangCwd: dir,
      agent: backend.agent,
      live: backend.live,
      kind: backend.kind,
      backend,
      session,
      promptOptions: [],
      ring: new ReplayRing({
        coalesceMs: this.deltaCoalesceMs,
        deliver: (msg) => this.deliver(entry, msg),
      }),
      viewports: new Set(),
      remoteViewports: new Set(),
      name: path.basename(dir) || dir,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    return this.activate(entry);
  }

  get(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  /** Active entry or a lazily reopened checkpoint. A saved-but-unavailable
   * session throws so callers can surface the reason without falling through
   * to the stale-URL "make a blank session" branch. */
  open(id: string): SessionEntry | undefined {
    const active = this.entries.get(id);
    if (active) return active;
    const loadError = this.restoreErrors.get(id);
    if (loadError) {
      throw new Error(`session ${id} is saved but its checkpoint is unavailable: ${loadError}`);
    }
    const stored = this.dormant.get(id);
    if (!stored) return undefined;

    const backend = restoreBackend(stored);
    const cwd = resolveCwd(stored.cwd);
    const model = stored.model ?? backend.model;
    const restoredBackend = { ...backend, ...(model ? { model } : {}) };
    const session = createSession(restoredBackend, { cwd, resumeId: stored.resumeId });
    const { buffer, nextSeq } = recoverStoredTranscript(stored);
    const bangCwd = this.restoredBangCwd(cwd, stored.bangCwd);
    const entry: SessionEntry = {
      ...IDLE_STATE,
      id: stored.id,
      cwd,
      bangCwd,
      agent: restoredBackend.agent,
      live: restoredBackend.live,
      kind: restoredBackend.kind,
      backend: restoredBackend,
      session,
      promptOptions: normalizePromptOptions(stored.promptOptions).map((option) => ({ ...option })),
      ring: ReplayRing.restore(buffer, nextSeq, {
        coalesceMs: this.deltaCoalesceMs,
        deliver: (msg) => this.deliver(entry, msg),
      }),
      viewports: new Set(),
      remoteViewports: new Set(),
      name: stored.name,
      lastActivity: stored.lastActivity,
      createdAt: stored.createdAt,
      ...(stored.usage ? { usage: { ...stored.usage } } : {}),
    };
    return this.activate(entry);
  }

  /** Register either a fresh or recovered engine at the one lifecycle seam. */
  private activate(entry: SessionEntry): SessionEntry {
    entry.session.onMessage((msg) => this.broadcast(entry, msg));
    this.entries.set(entry.id, entry);
    this.dormant.delete(entry.id);
    entry.session.onResumeId?.(() => {
      if (this.entries.get(entry.id) === entry) this.checkpoint(entry);
    });
    // An adapter with an optimistic hello-time kind publishes the
    // truthful one once its engine classifies the pinned provider. Until
    // then the entry is kindPending and the relay gate refuses remote
    // actions (provider-policy.ts relayGateRefusal). The truthful kind is
    // checkpointed so recovery starts from it — and re-verifies anyway.
    if (entry.session.onBackendKind) {
      entry.kindPending = true;
      entry.session.onBackendKind((update) => {
        if (this.entries.get(entry.id) !== entry) return;
        entry.kind = update.kind;
        entry.kindPending = false;
        entry.backend.kind = update.kind;
        if (update.provider) entry.backend.provider = update.provider;
        // A mid-session flip to a relay-ineligible kind (an OpenCode `/model`
        // switch to a subscription or the Zen gateway) must evict any remote
        // (relay) viewport already attached — the same posture the attach
        // gate takes for a fresh remote attach. The
        // drive-time gate in connection.ts refuses their prompts regardless;
        // this stops them receiving the now-subscription stream at all.
        if (!allowedOverRelay(update.kind)) this.evictRemoteViewports(entry);
        this.checkpoint(entry);
      });
    }
    entry.session.refreshPromptOptions?.();
    this.checkpoint(entry);
    this.notifyWatchers();
    // create() is normally followed immediately by attach(), which clears
    // this timer. open() can also be reached by a fleet quick prompt with no
    // viewport at all; that path still needs the same eventual unload as a
    // detached session instead of pinning a revived engine forever.
    if (entry.viewports.size === 0) this.armIdleUnload(entry);
    return entry;
  }

  private restoredBangCwd(root: string, candidate: string): string {
    const resolved = path.resolve(candidate);
    const inside = resolved === root || resolved.startsWith(`${root}${path.sep}`);
    if (!inside) return root;
    try {
      return statSync(resolved).isDirectory() ? resolved : root;
    } catch {
      return root;
    }
  }

  private snapshot(entry: SessionEntry): StoredSession {
    return {
      version: 1,
      id: entry.id,
      cwd: entry.cwd,
      bangCwd: entry.bangCwd,
      backend: { ...entry.backend },
      ...(entry.session.resumeId ? { resumeId: entry.session.resumeId } : {}),
      promptOptions: entry.promptOptions,
      buffer: entry.ring.buffer,
      nextSeq: entry.ring.nextSeq,
      name: entry.name,
      status: entry.status,
      lastActivity: entry.lastActivity,
      createdAt: entry.createdAt,
      ...(entry.session.modelName ? { model: entry.session.modelName } : {}),
      ...(entry.usage ? { usage: { ...entry.usage } } : {}),
    };
  }

  /** Synchronous at user/terminal boundaries; high-volume interior stream
   * frames share a short debounce and are caught by the terminal boundary. */
  private checkpoint(entry: SessionEntry): StoredSession | undefined {
    if (!this.store) return undefined;
    clearTimeout(entry.checkpointTimer);
    entry.checkpointTimer = undefined;
    const stored = this.snapshot(entry);
    try {
      this.store.write(stored);
      this.restoreErrors.delete(entry.id);
      return stored;
    } catch (err) {
      createLogger(`session ${entry.id}`).error(
        `could not checkpoint session: ${errText(err)}`,
      );
      return undefined;
    }
  }

  private scheduleCheckpoint(entry: SessionEntry, msg: SessionMsg) {
    if (!this.store) return;
    const synchronous =
      msg.type === "user_prompt" ||
      msg.type === "turn_end" ||
      msg.type === "error" ||
      msg.type === "permission_request" ||
      msg.type === "permission_resolved" ||
      msg.type === "bang_start" ||
      msg.type === "bang_end";
    if (synchronous) {
      this.checkpoint(entry);
      return;
    }
    if (entry.checkpointTimer) return;
    entry.checkpointTimer = setTimeout(() => {
      entry.checkpointTimer = undefined;
      this.checkpoint(entry);
    }, 250);
    entry.checkpointTimer.unref();
  }

  /**
   * Buffer a message and fan it out to every attached viewport. Consecutive
   * text/thinking deltas merge inside the coalescing window into one WireMsg
   * whose text is their concatenation; any other message — and a delta of
   * the other type — flushes the window first, so the buffered stream keeps
   * the adapter's exact order.
   */
  broadcast(entry: SessionEntry, msg: SessionMsg) {
    // Adapter callbacks can settle after close (catalog probes, permission
    // denial, an aborted child). Once teardown has removed this exact entry,
    // none of those callbacks may fan out or recreate its deleted checkpoint.
    if (this.entries.get(entry.id) !== entry) return;
    // Before persistence, buffering, or any viewport. Catalog metadata can
    // originate in user-installed skills/MCP servers, so it shares the same
    // bounded choke point as engine-authored tool and status labels.
    const normalized = normalizeWireMetadata(msg);
    if (!normalized) {
      createLogger(`session ${entry.id}`).warn(`dropped a ${msg.type} frame the checkpoint decoder would refuse`);
      return;
    }
    msg = normalized;
    // Replaceable shell metadata, not transcript history: one catalog is
    // enough, and it must not consume a resume sequence number.
    if (msg.type === "prompt_options") {
      entry.promptOptions = msg.options;
      this.checkpoint(entry);
      this.fanout(entry, msg);
      return;
    }
    entry.ring.offer(msg);
  }

  private deliver(entry: SessionEntry, msg: SessionMsg) {
    const log = createLogger(`session ${entry.id}`);
    // The likeliest live failures (bad key, engine died, CLI missing)
    // arrive here as adapter-emitted `error` WireMsgs — mirror them to the
    // terminal, timestamped, because the terminal log is what a stranger
    // pastes into a bug report.
    if (msg.type === "error") {
      log.error(msg.message);
    }
    // Paintings-adoption instrumentation: one LOCAL log line per
    // generative-UI paint, from the choke point every adapter's stream
    // crosses — so "does this engine actually reach for the render tools"
    // is answerable from the daemon log instead of guessed. Local only;
    // nothing leaves the machine.
    if (msg.type === "render" || msg.type === "artifact") {
      log.info(`paint ${msg.type === "render" ? msg.component : "artifact"} agent=${entry.agent}`);
    }
    // MIRAFOLD_DEBUG=1 traces every normalized event on the session
    // stream (bang_input never crosses broadcast, so no secret can land
    // here). One line per WireMsg, payload truncated.
    if (verbose) {
      const body = JSON.stringify(msg);
      log.debug(`${msg.type} ${body.length > 300 ? body.slice(0, 300) + "…" : body}`);
    }
    msg = entry.ring.push(msg);
    entry.lastActivity = Date.now();
    const watchersChanged = this.applyState(entry, { kind: "message", msg });
    // Semantic boundaries write their atomic checkpoint synchronously before
    // the browser can observe the frame. In particular, `turn_end` must not
    // reach a viewport while the complete record is still only a .tmp file:
    // an immediate daemon death in that window would acknowledge a finished
    // turn and reopen the previous partial checkpoint on restart.
    this.scheduleCheckpoint(entry, msg);
    if (watchersChanged) this.notifyWatchers();
    this.fanout(entry, msg);
  }

  /** Run the stream-state reducer and adopt its result; returns whether
   *  fleet-visible metadata changed. */
  private applyState(entry: SessionEntry, input: SessionStateInput): boolean {
    const { state, watchersChanged } = reduceSessionState(entry, input);
    entry.status = state.status;
    entry.modelTurnsPending = state.modelTurnsPending;
    entry.errorAwaitingTurnEnd = state.errorAwaitingTurnEnd;
    entry.activity = state.activity;
    entry.permissions = state.permissions;
    entry.usage = state.usage;
    return watchersChanged;
  }

  /** Send one message to every attached viewport — fan-out only, no buffering. */
  private fanout(entry: SessionEntry, msg: WireMsg) {
    for (const viewport of entry.viewports) viewport(msg);
  }

  /**
   * Can a viewport that last saw `afterSeq` resume with a tail replay?
   * Only if nothing after it has fallen off the ring buffer, and it isn't
   * from some other life (a seq we never issued).
   */
  canResume(entry: SessionEntry, afterSeq: number): boolean {
    return entry.ring.canResume(afterSeq);
  }

  /** Mark an attached viewport as REMOTE (relay) — connection.ts calls this
   *  right after attach for a relay connection, so a later kind flip can
   *  evict it. Idempotent; a subset of `viewports`. */
  markRemote(entry: SessionEntry, viewport: Viewport) {
    if (entry.viewports.has(viewport)) entry.remoteViewports.add(viewport);
  }

  /** Refuse-and-detach every remote viewport on this entry — the mid-session
   *  equivalent of the attach-time relay gate. */
  private evictRemoteViewports(entry: SessionEntry) {
    for (const viewport of [...entry.remoteViewports]) {
      // Detach first: the connection reads "no longer attached" off the
      // `refused` frame to drop its own session handle (connection.ts).
      this.detach(entry, viewport);
      viewport({
        type: "refused",
        reason: "subscription-relay",
        message: relayGateRefusal({ kind: entry.kind, kindPending: entry.kindPending }) ??
          "This session can no longer be driven over the relay.",
      });
    }
  }

  /**
   * Replay history into the viewport, then subscribe it to the live stream.
   * With `afterSeq` (pre-validated via canResume) only the unseen tail is
   * replayed — the reconnecting viewport keeps its state, no repaint.
   */
  attach(entry: SessionEntry, viewport: Viewport, afterSeq?: number) {
    clearTimeout(entry.idleTimer);
    for (const msg of entry.ring.replayAfter(afterSeq)) viewport(msg);
    entry.viewports.add(viewport);
    if (entry.promptOptions.length) {
      viewport({ type: "prompt_options", options: entry.promptOptions });
    }
    // First viewport in → the doorbell starts; last detach stops it.
    if (entry.viewports.size === 1 && !entry.fsWatch) {
      entry.fsWatch = this.startFsWatch(entry);
    }
    this.notifyWatchers(); // viewport counts are fleet metadata
  }

  /**
   * The live-tree doorbell: every ring fans an fs_changed to the
   * ATTACHED viewports — per-viewport plumbing like the fs_* replies, never
   * through broadcast(): disk state is a query, not session history, so the
   * bell must not enter the replay ring. Statuses are invalidated BEFORE
   * the fan so a bell-triggered refetch can't be served a pre-change answer
   * still inside its TTL. Watcher failure degrades to the bell-less
   * behavior (turn-end refresh + the manual button): one shell-composed notice to
   * attached viewports, one log line, never a crash — and a later fresh
   * first attach retries.
   */
  private startFsWatch(entry: SessionEntry): FsWatchHandle {
    return startWatch(
      entry.cwd,
      (change) => {
        invalidateRepoStatusCache();
        const msg: WireMsg = {
          type: "fs_changed",
          ...(change.paths.length ? { paths: change.paths } : {}),
          ...(change.truncated ? { truncated: true } : {}),
        };
        this.fanout(entry, msg);
        if (verbose) {
          createLogger(`session ${entry.id}`).debug(
            `fs change: ${change.paths.length} path(s)${change.truncated ? " (truncated)" : ""}`,
          );
        }
      },
      {
        onError: (err) => {
          entry.fsWatch = undefined;
          const notice: WireMsg = {
            type: "notice",
            text: "Live file updates are unavailable — the Files panel still refreshes at turn end and with its refresh button.",
          };
          this.fanout(entry, notice);
          createLogger(`session ${entry.id}`).error(
            `fs watcher stopped — the folder tree falls back to turn-end/manual refresh: ${errText(err)}`,
          );
        },
      },
    );
  }

  /** Detaching never closes the session — the idle timer does, much later. */
  detach(entry: SessionEntry, viewport: Viewport) {
    entry.ring.flush(); // the leaving viewport sees the stream's true tail
    entry.viewports.delete(viewport);
    entry.remoteViewports.delete(viewport);
    if (entry.viewports.size === 0) {
      entry.fsWatch?.stop(); // nobody listening → no watches held
      entry.fsWatch = undefined;
    }
    // Both `=== entry` guards skip a session already ended: end() deletes it
    // from the map, and a later detach must neither re-create its deleted
    // checkpoint nor re-arm the idle timer / double-close the engine.
    if (this.entries.get(entry.id) === entry) this.checkpoint(entry);
    this.notifyWatchers(); // viewport counts are fleet metadata
    // The `=== entry` guard skips this for a session already ended:
    // end() deletes it from the map, so a later detach mustn't re-arm the idle
    // timer or double-close the engine.
    if (entry.viewports.size === 0 && this.entries.get(entry.id) === entry) {
      this.armIdleUnload(entry);
    }
  }

  /** A session revived or minted by a request that ended up attaching nothing
   *  (a refused remote attach or act): return it to the ordinary idle-unload
   *  path instead of leaving its engine warm indefinitely. A no-op for a
   *  session that has viewports or was already ended. */
  releaseIfUnviewed(entry: SessionEntry) {
    if (entry.viewports.size === 0 && this.entries.get(entry.id) === entry) {
      this.armIdleUnload(entry);
    }
  }

  private armIdleUnload(entry: SessionEntry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.viewports.size !== 0 || this.entries.get(entry.id) !== entry) return;
      entry.ring.flush();
      if (this.store) {
        const stored = this.checkpoint(entry);
        // Never trade a failed disk write for data loss. Keep the warm engine
        // and retry after another idle window instead.
        if (!stored) {
          this.armIdleUnload(entry);
          return;
        }
        this.teardown(entry);
        this.dormant.set(entry.id, stored);
      } else {
        this.teardown(entry);
      }
      this.notifyWatchers();
    }, this.idleTimeoutMs);
    entry.idleTimer.unref();
  }

  /** The death core both paths share: kill any running PTY (no orphaned PTYs
   *  past the session's life), close the engine, drop it from the fleet. */
  private teardown(entry: SessionEntry) {
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.checkpointTimer);
    entry.checkpointTimer = undefined;
    entry.bang?.proc.kill();
    // Remove first: close() may synchronously resolve pending permissions, and
    // asynchronous catalog/engine callbacks can arrive later. broadcast()'s
    // identity guard then makes all of them inert.
    this.entries.delete(entry.id);
    entry.session.close();
  }

  /**
   * Explicit teardown — the user chose "end session". Kill any running
   * PTY, close the engine, drop it from the fleet, and tell attached viewports
   * it's over (they leave to mission control). A subsequent detach on this
   * entry is a no-op (guarded above), so close() runs exactly once.
   */
  end(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) {
      const existed = this.dormant.has(id) || this.restoreErrors.has(id);
      if (!existed) return false;
      this.store?.delete(id);
      this.dormant.delete(id);
      this.restoreErrors.delete(id);
      this.notifyWatchers();
      return true;
    }
    entry.ring.flush(); // pending stream text lands before session_ended
    // Delete the durable copy BEFORE dropping the live engine. If disk
    // refuses the explicit delete, the session remains usable and the caller
    // gets an error instead of being told it ended while it can reappear.
    this.store?.delete(id);
    clearTimeout(entry.idleTimer);
    entry.fsWatch?.stop();
    entry.fsWatch = undefined;
    this.teardown(entry);
    this.dormant.delete(id);
    this.restoreErrors.delete(id);
    this.fanout(entry, { type: "session_ended", sessionId: id });
    this.notifyWatchers();
    return true;
  }

  // ---- Fleet watchers: connections that observe the registry itself —
  // the mission-control page — rather than any one session's stream.

  private watchers = new Set<Viewport>();
  private notifyTimer: NodeJS.Timeout | null = null;

  summary(): SessionMeta[] {
    const active: SessionMeta[] = [...this.entries.values()].map((e) => ({
      sessionId: e.id,
      name: e.name,
      cwd: e.cwd,
      agent: e.agent,
      model: e.session.modelName,
      status: e.status,
      lastActivity: e.lastActivity,
      viewports: e.viewports.size,
      createdAt: e.createdAt,
      // Copies, and absent-when-empty: a watcher's serialized
      // snapshot must not alias entry state, and old clients strip fields
      // they don't know rather than seeing empty placeholders.
      ...(e.activity ? { activity: { ...e.activity } } : {}),
      // askedAt stays server-side — the wire shape is unchanged.
      ...(e.permissions.length
        ? { permissions: e.permissions.map(({ id, tool, detail }) => ({ id, tool, detail })) }
        : {}),
      ...(e.usage ? { usage: { ...e.usage } } : {}),
    }));
    const dormant: SessionMeta[] = [...this.dormant.values()].map((stored) => ({
      sessionId: stored.id,
      name: stored.name,
      cwd: stored.cwd,
      agent: stored.backend.agent,
      model: stored.model,
      status: "idle",
      lastActivity: stored.lastActivity,
      viewports: 0,
      createdAt: stored.createdAt,
      ...(stored.usage ? { usage: { ...stored.usage } } : {}),
    }));
    return [...active, ...dormant].sort((a, b) => b.lastActivity - a.lastActivity);
  }

  watch(viewport: Viewport) {
    this.watchers.add(viewport);
    viewport({ type: "sessions", sessions: this.summary() });
  }

  unwatch(viewport: Viewport) {
    this.watchers.delete(viewport);
  }

  rename(id: string, name: string): boolean {
    const entry = this.entries.get(id);
    const clean = name.trim().slice(0, 60);
    if (!clean) return false;
    if (entry) {
      const previous = entry.name;
      entry.name = clean;
      if (this.store && !this.checkpoint(entry)) {
        entry.name = previous;
        return false;
      }
    } else {
      const stored = this.dormant.get(id);
      if (!stored || !this.store) return false;
      const renamed = { ...stored, name: clean };
      try {
        this.store.write(renamed);
      } catch (err) {
        createLogger(`session ${id}`).error(`could not save session rename: ${errText(err)}`);
        return false;
      }
      this.dormant.set(id, renamed);
    }
    this.notifyWatchers();
    return true;
  }

  // ---- Cockpit acts: sessionId-addressed, usable from a fleet watcher
  // without attaching. Each returns false for an unknown session — the caller
  // turns that into an error reply, never a crash. The relay gate for the
  // acts that drive the model lives in connection.ts, beside its attach twin.

  /** Answer a session's pending permission — BOTH answer paths land here:
   *  the grid's answer_permission and the in-session permission_response
   *  (connection.ts routes it through, so the queue and the watchers stay
   *  in sync with the adapter). The answered id is dropped from the queue
   *  immediately (honest feedback before the stream moves — the allowed
   *  tool may take a moment to start); a concurrently pending second
   *  request stays visible. A stale id is a no-op at the adapter. */
  answerPermission(id: string, permissionId: string, allow: boolean): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.session.resolvePermission(permissionId, allow);
    if (this.applyState(entry, { kind: "permission_answered", id: permissionId })) {
      this.notifyWatchers();
    }
    return true;
  }

  /** Halt a session's in-flight turn from the grid; the session stays warm. */
  interruptSession(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.session.interrupt();
    return true;
  }

  /**
   * Every model-driving prompt enters through here — the `prompt` case, the
   * grid's `prompt_session`, a component `action{kind:prompt}` — echoing the
   * user turn through the stream (so every viewport and the replay buffer
   * render the command strip), then pushing it to the engine, behind the
   * burst gate. Returns false when the gate refuses; the caller owes the
   * sender PROMPT_GATE_REFUSAL and nothing reaches the stream.
   *
   * The gate: nothing else bounds a client that bursts prompts, each of
   * which costs a model turn, and the artifact bridge reaches
   * `action{kind:prompt}` with no user gesture (its 400ms gate is
   * client-side — a hostile client simply wouldn't run it). Keyed on the
   * turn grammar, never a clock (timing from the last accepted prompt
   * punishes legitimate back-to-back turns): a prompt while idle starts the
   * turn; ONE more may arrive while it runs — the terminal agents queue
   * typed-mid-turn input, so refusing a single queued follow-up would break
   * parity (desktop Enter still sends while busy); anything past that is
   * refused until a model-terminal event (turn_end / error) clears the
   * gate in broadcast(). Burn is capped near one turn per completed turn,
   * and no human pace — nor the suite's — can trip it.
   */
  dispatchPrompt(entry: SessionEntry, text: string): boolean {
    if (entry.modelTurnsPending > 1) return false;
    this.applyState(entry, { kind: "prompt_accepted" });
    this.broadcast(entry, { type: "user_prompt", text });
    entry.session.pushPrompt(text);
    return true;
  }

  /** Record a model turn started outside dispatchPrompt — currently the
   * transcript a completed `!` command sends directly to the adapter. If a
   * turn is already active, that transcript consumes its queued-follow-up
   * slot just like typed input would. */
  markModelTurnStarted(entry: SessionEntry) {
    if (this.entries.get(entry.id) !== entry) return;
    this.applyState(entry, { kind: "prompt_accepted" });
  }

  /** Push a fresh snapshot to every watcher, coalescing bursts. */
  private notifyWatchers() {
    if (this.watchers.size === 0 || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const msg: WireMsg = { type: "sessions", sessions: this.summary() };
      for (const w of this.watchers) w(msg);
    }, 100);
    this.notifyTimer.unref();
  }
}
