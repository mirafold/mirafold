import type { ClientMsg, WireMsg } from "@protocol";

type PickFolder = Extract<ClientMsg, { type: "pick_folder" }>;
type PendingRequest = {
  resolve: (path: string | undefined) => void;
  reject: (err: Error) => void;
};

/** Correlated client half of N2's folder-picker request/reply. Shared by the
 *  session shell and mission control: both surfaces own an Onboarding card. */
export function createFolderPickerRequests(
  send: (msg: PickFolder) => void | boolean,
  mintId: () => string = () => `fp-${Math.random().toString(36).slice(2, 10)}`,
) {
  const pending = new Map<string, PendingRequest>();

  return {
    request(cwd?: string): Promise<string | undefined> {
      const id = mintId();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          if (send({ type: "pick_folder", id, ...(cwd ? { cwd } : {}) }) === false) {
            throw new Error(
              "The connection is not ready. Try Browse again once Mirafold is connected.",
            );
          }
        } catch (err) {
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    /** True means this frame belonged to the picker and should not fan out. */
    handle(msg: WireMsg): boolean {
      if (msg.type !== "folder_picked") return false;
      const waiting = pending.get(msg.id);
      if (!waiting) return true;
      pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(msg.error));
      else waiting.resolve(msg.path);
      return true;
    },
    disconnect(): void {
      for (const waiting of pending.values()) {
        waiting.reject(new Error("The connection closed while the folder picker was open."));
      }
      pending.clear();
    },
  };
}
