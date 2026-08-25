import type { Action, AgentName, BackendChoice, WireMsg } from "@protocol";
import { SocketClient } from "./ws";
import { createDaemonClient, mintId, type SubscriptionAct } from "./daemon-client";
import { sessionIdFromPath, sessionPath } from "./session-url";

export type { SubscriptionAct } from "./daemon-client";
export { sendSubscriptionRequest } from "./daemon-client";

/**
 * What the output zone consumes: the wire protocol plus one local control
 * message — zone_reset clears the transcript before a replay repaints it
 * (fired on a non-resumed session_created; a tail resume skips it).
 */
export type ZoneMsg = WireMsg | { type: "zone_reset" };

/**
 * The session bus: the shell's single connection to the daemon — one
 * SocketClient plus the pub/sub that fans its messages out to the output
 * zone and the shell's own state. Shell.tsx consumes this named interface
 * instead of embedding a messaging system.
 */
export interface SessionBus {
  /** Output-zone subscription; returns the unsubscribe. */
  subscribe(l: (m: ZoneMsg) => void): () => void;
  /** Socket up/down; `refusal` is a short reason on a relay-refused close
   *  (down only), undefined for an ordinary drop or when up. Returns unsubscribe. */
  onConnection(cb: (c: boolean, refusal?: string) => void): () => void;
  createSession(agent: AgentName, cwd?: string, backend?: BackendChoice): void;
  /** Ask the daemon to re-probe local servers and re-send the agents hello. */
  refreshAgents(): void;
  /** Open the host's native folder dialog. A cancel resolves undefined; a
   *  daemon/platform failure rejects with the shell-owned explanation. */
  pickFolder(cwd?: string): Promise<string | undefined>;
  sendPrompt(text: string): void;
  /** Returns the minted bang id so the issuing viewport can correlate. */
  sendBang(command: string): string;
  sendBangInput(id: string, data: string): void;
  killBang(id: string): void;
  interrupt(): void;
  answerPermission(id: string, allow: boolean): void;
  endSession(): void;
  sendAction(action: Action, sourceId: string): void;
  /** folder tree/Changes: request ONE directory's listing, the complete changed
   *  set, a file's content, or a file's diff. Each mints and returns a
   *  correlation id — the reply echoes it, so a
   *  component can drop a reply that isn't the one it's currently waiting
   *  on. The whole-tree fs_list is retired from the client; the daemon still
   *  answers it for older bundles (the version-skew floor). */
  requestFsListdir(path: string): string;
  requestFsChanges(): string;
  requestFsRead(path: string): string;
  requestFsDiff(path: string): string;
  /** One manage-subscription request (status/cancel/uncancel);
   *  the single `subscription` reply echoes the returned minted id. */
  requestSubscription(act: SubscriptionAct): string;
  /** Stream a dropped file's bytes to the daemon's staging dir.
   *  Mints and returns the correlation id; the done/error reply echoes it. */
  uploadBegin(name: string, size: number): string;
  uploadChunk(id: string, data: string): void;
  uploadAbort(id: string): void;
}

export function createSessionBus(): SessionBus {
  const socket = new SocketClient();
  const listeners = new Set<(m: ZoneMsg) => void>();
  const connListeners = new Set<(c: boolean, refusal?: string) => void>();
  const daemon = createDaemonClient(socket);
  // The URL carries the session identity; no id yet means "create one".
  let sessionId = sessionIdFromPath(location.pathname);
  // Attach to a known session; otherwise send nothing and wait in the agent picker
  // (no agent is assumed, so we don't auto-create). The hello names the
  // last seq this viewport saw, asking for a tail-only resume.
  socket.setHello(() =>
    sessionId
      ? { type: "attach", sessionId, afterSeq: socket.lastSeq ?? undefined }
      : null,
  );
  socket.onOpen(() => {
    for (const c of connListeners) c(true);
  });
  socket.onClose((refusal) => {
    daemon.disconnect();
    for (const c of connListeners) c(false, refusal);
  });
  socket.onMessage((m) => {
    if (daemon.handle(m)) return;
    if (m.type === "session_created") {
      sessionId = m.sessionId;
      history.replaceState(null, "", sessionPath(m.sessionId));
      // Full attach: the server replays the whole buffer next — clear the
      // zone so pre-attach residue never sits above the transcript.
      // Resumed attach: only the unseen tail follows — keep
      // everything (state, scroll, an in-flight streaming block).
      if (!m.resumed) {
        socket.lastSeq = null; // cursor restarts with the full replay
        for (const l of listeners) l({ type: "zone_reset" });
      }
    }
    if (m.type === "session_ended") {
      // The session is gone (ended here, from the fleet, or another tab)
      // — leave to mission control; there's nothing left to attach to.
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
    onConnection(cb: (c: boolean, refusal?: string) => void): () => void {
      connListeners.add(cb);
      return () => {
        connListeners.delete(cb);
      };
    },
    // session_created sets `sessionId`, so a later reconnect re-attaches.
    createSession(agent: AgentName, cwd?: string, backend?: BackendChoice) {
      daemon.createSession(agent, cwd, backend);
    },
    refreshAgents: daemon.refreshAgents,
    pickFolder: daemon.pickFolder,
    sendPrompt(text: string) {
      // No local echo — the server broadcasts the user_prompt to every
      // viewport (including this one), so all tabs stay identical.
      socket.send({ type: "prompt", text });
    },
    // Run a shell command in the session's cwd (the `!` path). The id
    // is minted here so this viewport can correlate the broadcast stream.
    sendBang(command: string): string {
      const id = mintId("bang");
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
    // session_ended, which routes this viewport back to mission control.
    endSession() {
      if (sessionId) socket.send({ type: "end_session", sessionId });
    },
    sendAction(action: Action, sourceId: string) {
      socket.send({ type: "action", action, sourceId });
    },
    // folder tree/Changes requests. Ids are minted here (the sendBang shape) and
    // returned so each shell surface correlates the one reply it gets.
    requestFsListdir(path: string): string {
      const id = mintId("fsl");
      socket.send({ type: "fs_listdir", id, path });
      return id;
    },
    requestFsChanges(): string {
      const id = mintId("fsc");
      socket.send({ type: "fs_changes", id });
      return id;
    },
    requestFsRead(path: string): string {
      const id = mintId("fsr");
      socket.send({ type: "fs_read", id, path });
      return id;
    },
    requestFsDiff(path: string): string {
      const id = mintId("fsd");
      socket.send({ type: "fs_diff", id, path });
      return id;
    },
    requestSubscription: daemon.requestSubscription,
    // The sendBang mint shape; per-viewport correlation only.
    uploadBegin(name: string, size: number): string {
      const id = mintId("up");
      socket.send({ type: "file_upload_begin", id, name, size });
      return id;
    },
    uploadChunk(id: string, data: string) {
      socket.send({ type: "file_upload_chunk", id, data });
    },
    uploadAbort(id: string) {
      socket.send({ type: "file_upload_abort", id });
    },
  };
}
