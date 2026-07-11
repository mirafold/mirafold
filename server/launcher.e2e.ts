import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tier-3 (`yarn test:e2e`, needs a fresh `yarn build`): the launcher's browser
// open must never tie the browser to the user's terminal. If the opener were
// spawned with inherited stdio and no browser is running yet, the opener
// BECOMES the browser and chatters into that terminal for its whole lifetime
// (Chrome's `[pid:pid:…] ERROR:…` / TensorFlow Lite lines — seen in user
// testing 2026-07-10, from a Chrome launched outside Mirafold). So this
// asserts the guarantee from inside the opener itself: a stub `xdg-open`
// first on PATH records where its stdio really points and whether it was
// detached into its own session.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "bin", "mirafold.js");
const DAEMON = path.join(ROOT, "dist-server", "index.js");

// /proc + xdg-open: the guarantee is per-platform code in openBrowser; this
// exercises the linux arm (the only one CI runs).
const linuxOnly = { skip: process.platform !== "linux" };

test("launcher opens the browser detached, stdio → /dev/null", linuxOnly, async () => {
  assert.ok(existsSync(DAEMON), "dist-server missing — test:e2e must run `yarn build` first");

  // cwd is a scratch dir: no .env, no sessions created — boot + open only.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "genui-launcher-"));
  const record = path.join(tmp, "opener-record");
  // Vars captured BEFORE the redirect, which would remap fd1 for the block.
  writeFileSync(
    path.join(tmp, "xdg-open"),
    `#!/usr/bin/env bash
fd0=$(readlink /proc/$$/fd/0)
fd1=$(readlink /proc/$$/fd/1)
fd2=$(readlink /proc/$$/fd/2)
sid=$(ps -o sid= -p $$ | tr -d " ")
printf 'args=%s\\nfd0=%s\\nfd1=%s\\nfd2=%s\\npid=%s\\nsid=%s\\n' \\
  "$*" "$fd0" "$fd1" "$fd2" "$$" "$sid" > "$MIRAFOLD_TEST_RECORD"
`,
  );
  chmodSync(path.join(tmp, "xdg-open"), 0o755);

  // detached: the launcher leads its own process group, so cleanup can kill
  // the daemon it spawns (the launcher's exit alone would orphan it).
  const child = spawn(process.execPath, [LAUNCHER], {
    cwd: tmp,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${tmp}:${process.env.PATH}`,
      MIRAFOLD_TEST_RECORD: record,
      // Same forced-empty credentials as the Tier-2 harness: no test may ever
      // reach a metered engine, even though this one never creates a session.
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
      CODEX_HOME: path.join(ROOT, "itest-no-codex-home"),
      CLAUDE_CONFIG_DIR: path.join(ROOT, "itest-no-claude-home"),
      MIRAFOLD_TOKEN: "",
      MIRAFOLD_RELAY_URL: "",
      MIRAFOLD_RELAY_CODE: "",
      PORT: String(3900 + Math.floor(Math.random() * 90)),
    },
  });
  let log = "";
  child.stdout.on("data", (d: Buffer) => (log += d));
  child.stderr.on("data", (d: Buffer) => (log += d));

  try {
    const deadline = Date.now() + 20_000;
    let url: string | undefined;
    while (Date.now() < deadline && !existsSync(record)) {
      url ??= log.match(/http:\/\/127\.0\.0\.1:\d+\/\S*/)?.[0];
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(existsSync(record), `opener never ran; launcher log:\n${log}`);
    url ??= log.match(/http:\/\/127\.0\.0\.1:\d+\/\S*/)?.[0];

    const got = Object.fromEntries(
      readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]),
    );
    assert.equal(got.args, url, "opener called with the daemon's printed URL");
    // The guarantee itself: nothing the opener (or the browser it may become)
    // writes can reach the terminal, and it survives the launcher's exit.
    assert.equal(got.fd0, "/dev/null");
    assert.equal(got.fd1, "/dev/null");
    assert.equal(got.fd2, "/dev/null");
    assert.equal(got.sid, got.pid, "opener is its own session leader (detached)");
  } finally {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {}
    await new Promise<void>((done) => {
      const hard = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
        done();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(hard);
        done();
      });
    });
    rmSync(tmp, { recursive: true, force: true });
  }
});
