// The browser bundle's own build version, inlined by Vite at build
// time from the same package.json the daemon reads — SocketClient announces
// it on attach/create so the daemon can log a skewed pair (R.4g).
//
// NAMED import, never the default: `import pkg from "…/package.json"` inlines
// the WHOLE manifest into the bundle every viewport downloads — the full
// dependency inventory with version ranges, plus the scripts — for the sake of
// one string (2026-07-25 audit). Pinned by bundle.e2e.ts.
import { version } from "../../package.json";

export const CLIENT_VERSION: string = version;
