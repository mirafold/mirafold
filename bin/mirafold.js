#!/usr/bin/env node
// mirafold launcher (Step 4.10): boot the daemon in the CURRENT directory
// (sessions default to it — terminal parity, 4.8) and open the browser once
// it's listening. The daemon does the real work; this is spawn + open only.
// `--no-open` skips the browser (tests, servers, second terminals).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const daemon = path.resolve(HERE, "..", "dist-server", "index.js");

// R.4g: --version/--help answer without booting anything. The launcher isn't
// bundled, so it reads the package.json shipped beside it at runtime.
const version = () =>
  JSON.parse(readFileSync(path.resolve(HERE, "..", "package.json"), "utf8")).version;

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(version());
  process.exit(0);
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    `mirafold v${version()} — a faithful browser re-skin of your terminal coding agent\n` +
      `\n` +
      `Usage: mirafold [options]\n` +
      `\n` +
      `Runs the local daemon in the current directory and opens the browser UI.\n` +
      `\n` +
      `Options:\n` +
      `  --no-open        don't open the browser (prints the URL only)\n` +
      `  -v, --version    print the version and exit\n` +
      `  -h, --help       show this help and exit\n` +
      `\n` +
      `Config is read from .env in the launch directory (see .env.example) —\n` +
      `agent credentials, PORT, GENUI_AGENT, GENUI_RELAY_URL, GENUI_DEBUG=1.`,
  );
  process.exit(0);
}

if (!existsSync(daemon)) {
  console.error(
    "mirafold: built server not found (dist-server/). " +
      "In a dev checkout run `yarn build` first (or use `yarn dev`); " +
      "an installed copy missing it should be reinstalled.",
  );
  process.exit(1);
}

const noOpen = process.argv.includes("--no-open");
const child = spawn(process.execPath, [daemon], {
  stdio: ["inherit", "pipe", "inherit"],
});

// The daemon prints its final URL (it may walk past a busy port, and it carries
// the auth token as ?token=…) — mirror stdout and open the browser on the first
// URL seen. \S* captures the token query, stopping at the space before "(ws…".
let opened = false;
child.stdout.on("data", (buf) => {
  process.stdout.write(buf);
  const m = String(buf).match(/http:\/\/127\.0\.0\.1:\d+\/\S*/);
  if (m && !opened) {
    opened = true;
    if (!noOpen) openBrowser(m[0]);
  }
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  // Best-effort: a headless box has no opener — the printed URL is the fallback.
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {});
}
