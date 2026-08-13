// File drag-and-drop input (Phase FD), client half. A browser drop hands
// over a file's NAME and BYTES — never its real path — so the shell streams
// the bytes to the daemon in bounded base64 chunks and, on the staged-path
// reply, hands the path to the prompt. Pure state + chunk math live here so
// Tier-1 can prove them without a DOM; Shell owns the listeners, the
// overlay, and the strip.
import type { WireMsg } from "@protocol";

export const FILE_DROP_MAX_FILES = 8;
// Decoded bytes per chunk: base64 inflates ×4/3, so the frame rides ~256 KB —
// under the daemon's per-chunk bound (300 KB decoded) AND well under the
// socket's MAX_WS_PAYLOAD (1 MB), which would kill the whole connection.
export const FILE_DROP_CHUNK_BYTES = 192_000;
// Mirror of the daemon's FILE_UPLOAD_MAX_BYTES default, for instant local
// refusal with the bytes never read. The daemon's cap stays authoritative —
// a daemon running a raised env limit just means this refuses earlier than
// it strictly must (accepted: the mirror is a courtesy, not the gate).
export const FILE_DROP_MAX_BYTES = 10_000_000;

export type UploadEntry = {
  id: string;
  name: string;
  status: "uploading" | "error";
  message?: string;
};

/** The slice of a DOM File the core needs — injectable for Tier-1. */
export type DroppedFile = {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

type FileDropDeps = {
  uploadBegin(name: string, size: number): string;
  uploadChunk(id: string, data: string): void;
  uploadAbort(id: string): void;
  /** The strip's render input — called with a fresh array on every change. */
  onChange(uploads: UploadEntry[]): void;
  /** A staged path is ready for the prompt. */
  onAttached(path: string, name: string): void;
};

export type FileDrop = {
  start(files: DroppedFile[]): void;
  /** Routes upload replies; true = consumed. */
  handle(msg: WireMsg): boolean;
  dismiss(id: string): void;
};

/** btoa needs a "binary string"; build it in bounded blocks — a spread of a
 *  multi-MB array would blow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(bin);
}

/** Path → prompt token, the terminal drop's shape: quoted only when it
 *  needs it, single-quote-escaped the POSIX way. */
export function quoteForPrompt(p: string): string {
  return /[\s'"\\$`]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : p;
}

export function createFileDrop(deps: FileDropDeps): FileDrop {
  const uploads: UploadEntry[] = [];
  let localId = 0;
  const emit = () => deps.onChange([...uploads]);
  const remove = (id: string) => {
    const at = uploads.findIndex((u) => u.id === id);
    if (at >= 0) uploads.splice(at, 1);
  };
  const failLocal = (name: string, message: string) => {
    uploads.push({ id: `local-${++localId}`, name, status: "error", message });
  };

  const uploadOne = async (f: DroppedFile) => {
    const id = deps.uploadBegin(f.name, f.size);
    uploads.push({ id, name: f.name, status: "uploading" });
    emit();
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      // A file that changed size between drop and read would desync the
      // declared total — the daemon refuses overflow, and a short read just
      // stalls out server-side; abort the honest way instead.
      if (bytes.length !== f.size) throw new Error("file changed while reading");
      for (let at = 0; at < bytes.length; at += FILE_DROP_CHUNK_BYTES) {
        deps.uploadChunk(id, toBase64(bytes.subarray(at, at + FILE_DROP_CHUNK_BYTES)));
      }
      // Zero-byte file: complete at begin — the reply is already on its way.
    } catch {
      deps.uploadAbort(id);
      remove(id);
      failLocal(f.name, "could not read the dropped file");
      emit();
    }
  };

  return {
    start(files) {
      for (const f of files.slice(0, FILE_DROP_MAX_FILES)) {
        if (f.size > FILE_DROP_MAX_BYTES) {
          failLocal(f.name, `too large (limit ${Math.floor(FILE_DROP_MAX_BYTES / 1_000_000)} MB)`);
          continue;
        }
        void uploadOne(f);
      }
      if (files.length > FILE_DROP_MAX_FILES) {
        failLocal(
          `${files.length - FILE_DROP_MAX_FILES} more file(s)`,
          `only the first ${FILE_DROP_MAX_FILES} of a drop are taken`,
        );
      }
      emit();
    },

    handle(msg) {
      if (msg.type === "file_upload_done") {
        remove(msg.id);
        emit();
        deps.onAttached(msg.path, msg.name);
        return true;
      }
      if (msg.type === "file_upload_error") {
        const u = uploads.find((x) => x.id === msg.id);
        if (u) {
          u.status = "error";
          u.message = msg.message;
        } else {
          // An error for an upload we no longer track (an abort's crossing
          // reply) still belongs to this feature — consume it silently.
        }
        emit();
        return true;
      }
      return false;
    },

    dismiss(id) {
      remove(id);
      emit();
    },
  };
}
