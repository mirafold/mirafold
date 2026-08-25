import type { WireMsg } from "../protocol";
import type { SessionEntry } from "./registry";

/**
 * What every per-connection handler factory (fs, bang, upload, folder
 * picker) receives from connection.ts — one shape, so a factory that forgets
 * to check `isClosed()` before an async reply is visible as a missing
 * destructure rather than a missing parameter. Each factory declares the
 * subset it uses with `Pick<ConnectionContext, …>`.
 */
export type ConnectionContext = {
  /** This viewport only — never the session stream. */
  viewport: (msg: WireMsg) => void;
  /** The session this connection watches, read at call time (it can change). */
  getEntry: () => SessionEntry | null;
  /** Whether the socket is already gone — checked before any async reply. */
  isClosed: () => boolean;
  /** True for a viewport arriving over the paid relay. */
  remote: boolean;
  /** Error to this viewport AND the terminal log. */
  sendError: (message: string) => void;
};
