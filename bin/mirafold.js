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
      `  --verbose        stream debug-level detail (same as MIRAFOLD_DEBUG=1)\n` +
      `  -v, --version    print the version and exit\n` +
      `  -h, --help       show this help and exit\n` +
      `\n` +
      `Config is read from .env in the launch directory (see .env.example) —\n` +
      `agent credentials, PORT, MIRAFOLD_AGENT, MIRAFOLD_RELAY_URL, MIRAFOLD_DEBUG=1.\n` +
      `\n` +
      `Logs: warnings/errors also land in ~/.local/state/mirafold/mirafold.log\n` +
      `(size-capped, no session content ever; MIRAFOLD_LOG_FILE moves it, empty disables).`,
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
// --verbose rides to the daemon as MIRAFOLD_DEBUG=1 — one debug switch, two spellings.
const child = spawn(process.execPath, [daemon], {
  stdio: ["inherit", "pipe", "inherit"],
  env: process.argv.includes("--verbose")
    ? { ...process.env, MIRAFOLD_DEBUG: "1" }
    : process.env,
});

// The daemon prints its final URL (it may walk past a busy port, and it carries
// the auth token as ?token=…) — mirror stdout and open the browser on the first
// URL seen. Matched against an ACCUMULATED tail, not per chunk: a line split
// across two data events matched neither chunk alone, and the browser never
// opened (2026-07-28 fix). The (?=\s) lookahead insists on the character after
// the URL — "(ws…"'s leading space or the newline — so a chunk ending mid-token
// can't open a truncated URL. \S* captures the token query.
let opened = false;
let bootTail = "";
child.stdout.on("data", (buf) => {
  process.stdout.write(buf);
  if (opened) return;
  bootTail = (bootTail + String(buf)).slice(-4096); // one boot line, bounded
  const m = bootTail.match(/http:\/\/127\.0\.0\.1:\d+\/\S*(?=\s)/);
  if (m) {
    opened = true;
    bootTail = "";
    if (!noOpen) {
      // Say it, because the open is often invisible: a compositor won't let a
      // background process raise a window, so an already-running browser just
      // gains a tab somewhere behind everything. Without this line a silent
      // success and a failed opener look identical, and the user reads a
      // working launch as broken (2026-07-30, Kyle's own first run).
      console.log("[mirafold] opening it in your browser — check your tabs if no window appears");
      openBrowser(m[0]);
    }
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
