import type { ClientMsg, WireMsg } from "@protocol";

type FolderPicked = Extract<WireMsg, { type: "folder_picked" }>;
type PickFolder = Extract<ClientMsg, { type: "pick_folder" }>;

/** Correlated client half of N2's folder-picker request/reply. Shared by the
 *  session shell and mission control: both surfaces own an Onboarding card. */
export function createFolderPickerRequests(
  send: (msg: PickFolder) => void | boolean,
  mintId: () => string = () => `fp-${Math.random().toString(36).slice(2, 10)}`,
) {
  const pending = new Map<
    string,
    { resolve: (path: string | undefined) => void; reject: (err: Error) => void }
  >();

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
      const reply = msg as FolderPicked;
      const waiting = pending.get(reply.id);
      if (!waiting) return true;
      pending.delete(reply.id);
      if (reply.error) waiting.reject(new Error(reply.error));
      else waiting.resolve(reply.path);
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
