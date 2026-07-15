import type { Action, AgentName, WireMsg } from "@protocol";
import { SocketClient } from "./ws";

/**
 * What the output zone consumes: the wire protocol plus one local control
 * message — zone_reset clears the transcript before a replay repaints it
 * (fired on a non-resumed session_created; a 4.4 tail resume skips it).
 */
export type ZoneMsg = WireMsg | { type: "zone_reset" };

/**
 * The session bus (H.9): the shell's single connection to the daemon — one
 * SocketClient plus the pub/sub that fans its messages out to the output
 * zone and the shell's own state. Extracted from Shell.tsx so the component
 * consumes a named interface instead of embedding a messaging system.
 */
export interface SessionBus {
  /** Output-zone subscription; returns the unsubscribe. */
  subscribe(l: (m: ZoneMsg) => void): () => void;
  /** Socket up/down; returns the unsubscribe. */
  onConnection(cb: (c: boolean) => void): () => void;
  createSession(agent: AgentName, cwd?: string): void;
  sendPrompt(text: string): void;
  /** Returns the minted bang id so the issuing viewport can correlate. */
  sendBang(command: string): string;
  sendBangInput(id: string, data: string): void;
  killBang(id: string): void;
  interrupt(): void;
  answerPermission(id: string, allow: boolean): void;
  endSession(): void;
  sendAction(action: Action, sourceId: string): void;
}

export function createSessionBus(): SessionBus {
  const socket = new SocketClient();
  const listeners = new Set<(m: ZoneMsg) => void>();
  const connListeners = new Set<(c: boolean) => void>();
  // The URL carries the session identity; no id yet means "create one".
  let sessionId = location.pathname.match(/^\/s\/([\w-]+)/)?.[1] ?? null;
  // Attach to a known session; otherwise send nothing and wait at onboarding
  // (P.4 — no agent is assumed, so we don't auto-create). 4.4: the hello
  // names the last seq this viewport saw, asking for a tail-only resume.
  socket.setHello(() =>
    sessionId
      ? { type: "attach", sessionId, afterSeq: socket.lastSeq ?? undefined }
      : null,
  );
  socket.onOpen(() => {
    for (const c of connListeners) c(true);
  });
  socket.onClose(() => {
    for (const c of connListeners) c(false);
  });
  socket.onMessage((m) => {
    if (m.type === "session_created") {
      sessionId = m.sessionId;
      history.replaceState(null, "", `/s/${m.sessionId}`);
      // Full attach: the server replays the whole buffer next — clear the
      // zone so pre-attach residue never sits above the transcript (4.8).
      // Resumed attach (4.4): only the unseen tail follows — keep
      // everything (state, scroll, an in-flight streaming block).
      if (!m.resumed) {
        socket.lastSeq = null; // cursor restarts with the full replay
        for (const l of listeners) l({ type: "zone_reset" });
      }
    }
    if (m.type === "session_ended") {
      // The session is gone (ended here, from the fleet, or another tab)
      // — leave to mission control; there's nothing left to attach to (#11).
      location.assign("/");
      return;
    }
    for (const l of listeners) l(m);
  });
  return {
    subscribe(l: (m: ZoneMsg) => void): () => void {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    onConnection(cb: (c: boolean) => void): () => void {
      connListeners.add(cb);
      return () => {
        connListeners.delete(cb);
      };
    },
    // The user picked an agent at onboarding — create a session on it.
    // session_created sets `sessionId`, so a later reconnect re-attaches (P.4).
    // `cwd` is the working dir typed at the picker; omitted → the
    // daemon's launch dir (4.8).
    createSession(agent: AgentName, cwd?: string) {
      socket.send({ type: "create", agent, cwd });
    },
    sendPrompt(text: string) {
      // No local echo — the server broadcasts the user_prompt to every
      // viewport (including this one), so all tabs stay identical.
      socket.send({ type: "prompt", text });
    },
    // Run a shell command in the session's cwd (the `!` path). The id
    // is minted here so this viewport can correlate the broadcast stream (4.9).
    sendBang(command: string): string {
      const id = `bang-${Math.random().toString(36).slice(2, 10)}`;
      socket.send({ type: "bang", command, id });
      return id;
    },
    // EPHEMERAL: PTY stdin (possibly a password) — the server writes it to
    // the process and nothing else; it never comes back on the wire.
    sendBangInput(id: string, data: string) {
      socket.send({ type: "bang_input", data, id });
    },
    killBang(id: string) {
      socket.send({ type: "bang_kill", id });
    },
    interrupt() {
      socket.send({ type: "interrupt" });
    },
    answerPermission(id: string, allow: boolean) {
      socket.send({ type: "permission_response", id, allow });
    },
    // End this session — the server tears it down and replies
    // session_ended, which routes this viewport back to mission control (#11).
    endSession() {
      if (sessionId) socket.send({ type: "end_session", sessionId });
    },
    sendAction(action: Action, sourceId: string) {
      socket.send({ type: "action", action, sourceId });
    },
  };
}
