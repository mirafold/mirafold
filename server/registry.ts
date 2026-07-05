import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { WireMsg } from "./protocol";
import { MockSession, Session, type AgentSession } from "./session";

// Replay depth: enough to reconstruct a long working session; beyond it the
// oldest messages fall off and a late viewport sees a truncated head.
const BUFFER_CAP = 4000;
// A session with no viewports survives this long, then dies for real.
const IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? 60 * 60_000);

export type Viewport = (msg: WireMsg) => void;

export type SessionEntry = {
  id: string;
  cwd: string;
  session: AgentSession;
  buffer: WireMsg[];
  viewports: Set<Viewport>;
  idleTimer?: NodeJS.Timeout;
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

  create(cwd?: string): SessionEntry {
    const id = randomUUID().slice(0, 8);
    // cwd is whatever the caller chose (default: workspace/<id>). A session is
    // like launching the terminal in a directory you own, so any dir is fair
    // game — safe because the socket binds to loopback (server/index.ts), so
    // only local-you can pick it, exactly as with the terminal. (An interim
    // build jailed this under workspace/; relaxed 2026-07-05 — the jail was
    // itself a deviation from terminal parity, and loopback already closes the
    // remote-cwd vector it was guarding.)
    const dir = path.resolve(cwd ?? path.join("workspace", id));
    mkdirSync(dir, { recursive: true }); // action tools need it even in mock mode
    // Live when any model credential/endpoint is configured — not just an
    // Anthropic API key. The SDK resolves ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN,
    // and a custom ANTHROPIC_BASE_URL points at a proxy/local endpoint (which
    // may need no key), so keying only on ANTHROPIC_API_KEY would silently drop
    // those setups into the mock. Fall back to the mock only when nothing is
    // configured. (Phase P.1 generalizes this to the provider config; today the
    // one live backend is the Anthropic SDK — this is provider-neutral seam
    // hygiene ahead of it, not the whole thing.)
    const live = Boolean(
      process.env.ANTHROPIC_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN ||
        process.env.ANTHROPIC_BASE_URL,
    );
    const session: AgentSession = live
      ? new Session({ workspaceDir: dir })
      : new MockSession();
    const entry: SessionEntry = { id, cwd: dir, session, buffer: [], viewports: new Set() };
    session.onMessage((msg) => this.broadcast(entry, msg));
    this.entries.set(id, entry);
    return entry;
  }

  get(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  /** Buffer a message and fan it out to every attached viewport. */
  broadcast(entry: SessionEntry, msg: WireMsg) {
    entry.buffer.push(msg);
    if (entry.buffer.length > BUFFER_CAP) {
      entry.buffer.splice(0, entry.buffer.length - BUFFER_CAP);
    }
    for (const viewport of entry.viewports) viewport(msg);
  }

  /** Replay history into the viewport, then subscribe it to the live stream. */
  attach(entry: SessionEntry, viewport: Viewport) {
    clearTimeout(entry.idleTimer);
    for (const msg of entry.buffer) viewport(msg);
    entry.viewports.add(viewport);
  }

  /** Detaching never closes the session — the idle timer does, much later. */
  detach(entry: SessionEntry, viewport: Viewport) {
    entry.viewports.delete(viewport);
    if (entry.viewports.size === 0) {
      entry.idleTimer = setTimeout(() => {
        entry.session.close();
        this.entries.delete(entry.id);
      }, IDLE_TIMEOUT_MS);
      entry.idleTimer.unref();
    }
  }
}
