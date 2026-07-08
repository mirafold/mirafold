// R.4g: the browser bundle's own build version, inlined by Vite at build
// time from the same package.json the daemon reads — SocketClient announces
// it on attach/create so the daemon can log a skewed pair.
import pkg from "../../package.json";

export const CLIENT_VERSION: string = pkg.version;
