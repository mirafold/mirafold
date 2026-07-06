import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WireMsg } from "./protocol";
import {
  createSession,
  resolveBackend,
  resolveBackendFor,
  type AgentName,
  type AgentSession,
  type Backend,
} from "./adapters";
import type { BangProc } from "./pty";

// Replay depth: enough to reconstruct a long working session; beyond it the
// oldest messages fall off and a late viewport sees a truncated head.
const BUFFER_CAP = 4000;
// A session with no viewports survives this long, then dies for real.
const IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? 60 * 60_000);

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
  session: AgentSession;
  buffer: WireMsg[];
  viewports: Set<Viewport>;
  // 4.4: next session-scoped sequence number; broadcast stamps it onto every
  // message so a reconnecting viewport can name where its stream broke off.
  nextSeq: number;
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
      session,
      buffer: [],
      viewports: new Set(),
      nextSeq: 1,
      pendingBang: [],
    };
    session.onMessage((msg) => this.broadcast(entry, msg));
    this.entries.set(id, entry);
    return entry;
  }

  get(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  /** Buffer a message and fan it out to every attached viewport. */
  broadcast(entry: SessionEntry, msg: WireMsg) {
    msg.seq = entry.nextSeq++; // 4.4: resume cursor, one stamp for all viewports
    entry.buffer.push(msg);
    if (entry.buffer.length > BUFFER_CAP) {
      entry.buffer.splice(0, entry.buffer.length - BUFFER_CAP);
    }
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
  }

  /** Detaching never closes the session — the idle timer does, much later. */
  detach(entry: SessionEntry, viewport: Viewport) {
    entry.viewports.delete(viewport);
    if (entry.viewports.size === 0) {
      entry.idleTimer = setTimeout(() => {
        entry.bang?.proc.kill(); // no orphaned PTYs past the session's life
        entry.session.close();
        this.entries.delete(entry.id);
      }, IDLE_TIMEOUT_MS);
      entry.idleTimer.unref();
    }
  }
}
