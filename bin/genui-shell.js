#!/usr/bin/env node
// genui-shell launcher (Step 4.10): boot the daemon in the CURRENT directory
// (sessions default to it — terminal parity, 4.8) and open the browser once
// it's listening. The daemon does the real work; this is spawn + open only.
// `--no-open` skips the browser (tests, servers, second terminals).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const daemon = path.resolve(HERE, "..", "dist-server", "index.js");

if (!existsSync(daemon)) {
  console.error(
    "genui-shell: built server not found (dist-server/). " +
      "In a dev checkout run `yarn build` first (or use `yarn dev`); " +
      "an installed copy missing it should be reinstalled.",
  );
  process.exit(1);
}

const noOpen = process.argv.includes("--no-open");
const child = spawn(process.execPath, [daemon], {
  stdio: ["inherit", "pipe", "inherit"],
});

// The daemon prints its final URL (it may walk past a busy port) — mirror
// stdout and open the browser on the first URL seen.
let opened = false;
child.stdout.on("data", (buf) => {
  process.stdout.write(buf);
  const m = String(buf).match(/http:\/\/127\.0\.0\.1:\d+/);
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
