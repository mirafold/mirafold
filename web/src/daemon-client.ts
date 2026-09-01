import type { AgentName, BackendChoice, ClientMsg, WireMsg } from "@protocol";
import { createFolderPickerRequests } from "./folder-picker-requests";
import type { SocketClient } from "./ws";

/** A per-viewport correlation id: minted client-side so each surface can
 *  match the one reply/stream it asked for. */
export const mintId = (prefix: string): string =>
  `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

export type SubscriptionAct = "status" | "cancel" | "uncancel";

/** Mint + send one manage-subscription request over any sender. The single
 *  `subscription` reply echoes the returned id. */
export function sendSubscriptionRequest(send: (m: ClientMsg) => void, act: SubscriptionAct): string {
  const id = mintId("sub");
  send(
    act === "status"
      ? { type: "subscription_status", id }
      : act === "cancel"
        ? { type: "subscription_cancel", id }
        : { type: "subscription_uncancel", id },
  );
  return id;
}

/**
 * The daemon-facing requests both pages make — the session viewport (through
 * its bus) and mission control (over its own watcher socket): create a
 * session, re-probe the agents hello, open the host folder dialog, and the
 * manage-subscription requests. One implementation so the two pages can't
 * send the same request two ways.
 */
export function createDaemonClient(socket: SocketClient) {
  const folderPicker = createFolderPickerRequests((msg) => socket.sendIfOpen(msg));
  return {
    /** The user picked an agent in the agent picker — create a session on it.
     *  `cwd` omitted → the daemon's launch dir; `backend` is the second-step
     *  choice, omitted → the daemon's credential-precedence default. */
    createSession(agent: AgentName, cwd?: string, backend?: BackendChoice) {
      socket.send({ type: "create", agent, cwd, ...(backend ? { backend } : {}) });
    },
    /** Re-probe local model servers and re-send the agents hello. */
    refreshAgents() {
      socket.send({ type: "refresh_agents" });
    },
    /** Open the host's native folder dialog. A cancel resolves undefined; a
     *  daemon/platform failure rejects with the shell-owned explanation. */
    pickFolder(cwd?: string): Promise<string | undefined> {
      return folderPicker.request(cwd);
    },
    requestSubscription(act: SubscriptionAct): string {
      return sendSubscriptionRequest((m) => socket.send(m), act);
    },
    /** Route a per-viewport reply; true when it was the folder picker's. */
    handle(m: WireMsg): boolean {
      return folderPicker.handle(m);
    },
    /** The socket dropped: pending picker requests can never be answered. */
    disconnect() {
      folderPicker.disconnect();
    },
  };
}
