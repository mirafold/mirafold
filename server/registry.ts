import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionMeta, WireMsg } from "./protocol";
import {
  createSession,
  resolveBackend,
  resolveBackendFor,
  type AgentName,
  type AgentSession,
  type Backend,
} from "./adapters";
import type { CredentialKind } from "./provider-policy";
import type { BangProc } from "./pty";

// Replay depth: enough to reconstruct a long working session; beyond it the
// oldest messages fall off and a late viewport sees a truncated head.
const BUFFER_CAP = 4000;
// A session with no viewports survives this long, then dies for real.
const IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? 60 * 60_000);
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
  agent: AgentName;
  // R.4b: false ⇒ the agent had no credentials and `session` is the scripted
  // mock — carried to the shell as session_created.demo so the banner draws.
  live: boolean;
  // R.4i: the credential kind behind this session — read by the relay gate in
  // connection.ts to refuse a subscription-backed session over the paid relay.
  kind: CredentialKind;
  session: AgentSession;
  buffer: WireMsg[];
  viewports: Set<Viewport>;
  // 4.4: next session-scoped sequence number; broadcast stamps it onto every
  // message so a reconnecting viewport can name where its stream broke off.
  nextSeq: number;
  // 4.6 fleet metadata: display name (defaults to the cwd leaf, renamable),
  // coarse activity state derived from the broadcast stream, and when the
  // stream last moved.
  name: string;
  status: SessionMeta["status"];
  lastActivity: number;
  idleTimer?: NodeJS.Timeout;
  // Step 4.9: the one running `!` command, if any (one at a time per session,
  // like a terminal). The proc itself never leaves the server.
  bang?: { id: string; proc: BangProc };
  // Finished `!` transcripts waiting to ride into the agent's context with
  // the next prompt — terminal-faithful: the model sees what you ran.
  pendingBang: string[];
};

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

  create(opts?: { cwd?: string; agent?: AgentName }): SessionEntry {
    if (this.entries.size >= MAX_SESSIONS) {
      throw new Error(`session limit reached (${MAX_SESSIONS})`);
    }
    const id = randomUUID().slice(0, 8);
    // Which agent this session runs (P.4): the caller's choice at onboarding,
    // resolved to a fresh backend here; no choice → the daemon default. Secrets
    // stay server-side — the client only ever names the agent.
    const backend = opts?.agent ? resolveBackendFor(opts.agent) : this.backend;
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
      pendingBang: [],
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
    // R.4g: the likeliest live failures (bad key, engine died, CLI missing)
    // arrive here as adapter-emitted `error` WireMsgs and used to reach only
    // the browser — mirror them to the terminal, timestamped, because the
    // terminal log is what a stranger pastes into a bug report.
    if (msg.type === "error") {
      console.error(
        `[${new Date().toISOString()}] [session ${entry.id}] error: ${msg.message}`,
      );
    }
    // R.4g: GENUI_DEBUG=1 traces every normalized event on the session
    // stream (bang_input never crosses broadcast, so no secret can land
    // here). One line per WireMsg, payload truncated.
    if (process.env.GENUI_DEBUG) {
      const body = JSON.stringify(msg);
      console.error(
        `[${new Date().toISOString()}] [debug ${entry.id}] ${msg.type} ${
          body.length > 300 ? body.slice(0, 300) + "…" : body
        }`,
      );
    }
    // 4.4: resume cursor, one stamp for all viewports. Stamped on a shallow
    // copy — the adapter's object is never mutated or held by the buffer, so
    // an adapter re-emitting a message can't corrupt an already-buffered seq.
    msg = { ...msg, seq: entry.nextSeq++ };
    entry.buffer.push(msg);
    if (entry.buffer.length > BUFFER_CAP) {
      entry.buffer.splice(0, entry.buffer.length - BUFFER_CAP);
    }
    entry.lastActivity = Date.now();
    // 4.6: coarse fleet status, derived from the stream itself — no adapter
    // cooperation needed. Terminal states first; a permission hold sticks
    // until the turn moves again.
    const prev = entry.status;
    if (msg.type === "turn_end" || msg.type === "error" || msg.type === "bang_end") {
      entry.status = "idle";
    } else if (msg.type === "permission_request") {
      entry.status = "permission";
    } else {
      entry.status = "working";
    }
    if (entry.status !== prev) this.notifyWatchers();
    for (const viewport of entry.viewports) viewport(msg);
  }

  /**
   * 4.4: can a viewport that last saw `afterSeq` resume with a tail replay?
   * Only if nothing after it has fallen off the ring buffer, and it isn't
   * from some other life (a seq we never issued).
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
    this.notifyWatchers(); // viewport counts are fleet metadata
  }

  /** Detaching never closes the session — the idle timer does, much later. */
  detach(entry: SessionEntry, viewport: Viewport) {
    entry.viewports.delete(viewport);
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
   * #11: explicit teardown — the user chose "end session". Kill any running
   * PTY, close the engine, drop it from the fleet, and tell attached viewports
   * it's over (they leave to mission control). A subsequent detach on this
   * entry is a no-op (guarded above), so close() runs exactly once.
   */
  end(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    clearTimeout(entry.idleTimer);
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
