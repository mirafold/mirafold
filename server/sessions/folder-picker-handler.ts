// Per-viewport wire handler for the host-native working-directory picker.
// The dialog is local shell chrome: never broadcast, replayed, or reachable
// through the paid relay. Every well-formed request gets one correlated reply.

import type { ClientMsg, WireMsg } from "../protocol";
import type { ConnectionContext } from "./handler-context";
import { errText } from "../adapters/types";
import { pickHostDirectory, type PickHostDirectory } from "../folder-picker";
import { CLIENT_ID_RE } from "./fs-handlers";

type PickFolder = Extract<ClientMsg, { type: "pick_folder" }>;
type FolderPicked = Extract<WireMsg, { type: "folder_picked" }>;

export type FolderPickerHandler = {
  pick: (msg: PickFolder) => void;
  close: () => void;
};

export function createFolderPickerHandler(
  opts: Pick<ConnectionContext, "viewport" | "remote" | "isClosed"> & {
    pickDirectory?: PickHostDirectory;
  },
): FolderPickerHandler {
  const pickDirectory = opts.pickDirectory ?? pickHostDirectory;
  let active: AbortController | null = null;

  const reply = (msg: FolderPicked) => {
    if (!opts.isClosed()) opts.viewport(msg);
  };
  const replyError = (id: string, error: string) => {
    reply({ type: "folder_picked", id, error });
  };

  const pick = (msg: PickFolder): void => {
    if (typeof msg.id !== "string" || !CLIENT_ID_RE.test(msg.id)) return;
    if (opts.remote) {
      replyError(
        msg.id,
        "Folder browsing is available only on the computer running Mirafold. Type a path on that computer instead.",
      );
      return;
    }
    if (typeof msg.cwd === "string" && msg.cwd.length > 4_096) {
      replyError(msg.id, "The working-directory path is too long.");
      return;
    }
    if (active) {
      replyError(msg.id, "A folder picker is already open. Choose a folder or cancel it first.");
      return;
    }

    const controller = new AbortController();
    active = controller;
    void pickDirectory(typeof msg.cwd === "string" ? msg.cwd : undefined, controller.signal)
      .then((selected) => {
        reply(
          selected
            ? { type: "folder_picked", id: msg.id, path: selected }
            : { type: "folder_picked", id: msg.id, canceled: true },
        );
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        replyError(msg.id, errText(err));
      })
      .finally(() => {
        if (active === controller) active = null;
      });
  };

  return {
    pick,
    close: () => {
      active?.abort();
      active = null;
    },
  };
}
