// The one place the package version enters the code. The JSON import
// is resolved at BUILD time — esbuild inlines it into dist-server and Vite
// into the web bundle — so the shipped artifacts carry their version with no
// runtime file read (and the web bundle's copy is what it announces back as
// clientVersion, making daemon↔client skew visible).
import pkg from "../package.json";

export const VERSION: string = pkg.version;
