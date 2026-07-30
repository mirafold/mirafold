import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRUBBED_CREDENTIAL_ENV } from "./itest-harness";

// Tier-3 (`yarn test:e2e`, needs a fresh `yarn build`): the launcher's browser
// open must never tie the browser to the user's terminal. If the opener were
// spawned with inherited stdio and no browser is running yet, the opener
// BECOMES the browser and chatters into that terminal for its whole lifetime
// (Chrome's `[pid:pid:…] ERROR:…` / TensorFlow Lite lines — seen in user
// testing 2026-07-10, from a Chrome launched outside Mirafold). So this
// asserts the guarantee from inside the opener itself: a stub `xdg-open`
// first on PATH records where its stdio really points and whether it was
// detached into its own session.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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
      ...SCRUBBED_CREDENTIAL_ENV,
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

// The SPA fallback must survive a global install under a DOT-DIRECTORY.
// `npm i -g` unpacks into the active Node's prefix, and for nvm (~/.nvm/…),
// asdf, volta and fnm that path carries a dot-segment. send's default
// dotfiles:"ignore" policy inspects EVERY segment of an ABSOLUTE path, so
// `sendFile(join(DIST, "index.html"))` 404'd there while `GET /` kept working
// (express.static passes a root, confining the check to the request path).
// Reported 2026-07-30 from a real tester-style install: onboarding died on the
// first session URL, for version-manager users only. Nothing caught it because
// the repo checkout has no dot-segment — this test manufactures one, which is
// the only way the suite can see the bug at all.
test("SPA fallback serves from an install path containing a dot-directory", async () => {
  assert.ok(existsSync(DAEMON), "dist-server missing — test:e2e must run `yarn build` first");

  const tmp = mkdtempSync(path.join(os.tmpdir(), "genui-dotpath-"));
  const dotRoot = path.join(tmp, ".nvm-like"); // the dot-segment IS the fixture
  mkdirSync(dotRoot, { recursive: true });
  cpSync(path.join(ROOT, "dist"), path.join(dotRoot, "dist"), { recursive: true });
  cpSync(path.join(ROOT, "dist-server"), path.join(dotRoot, "dist-server"), { recursive: true });
  // Symlinked, not copied: resolution walks up from the module, and copying
  // node_modules would dominate the test's runtime for no added coverage.
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dotRoot, "node_modules"));

  const child = spawn(process.execPath, [path.join(dotRoot, "dist-server", "index.js")], {
    cwd: tmp,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...SCRUBBED_CREDENTIAL_ENV,
      MIRAFOLD_APP_URL: "",
      MIRAFOLD_LICENSE_KEY: "",
      PORT: String(3990 + Math.floor(Math.random() * 9)),
    },
  });
  let log = "";
  child.stdout.on("data", (d: Buffer) => (log += d));
  child.stderr.on("data", (d: Buffer) => (log += d));

  try {
    const deadline = Date.now() + 20_000;
    let url: string | undefined;
    while (Date.now() < deadline && !url) {
      url = log.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(url, `daemon never printed its URL:\n${log}`);

    const res = await fetch(`${url}s/regression-check`);
    const body = await res.text();
    assert.equal(res.status, 200, `SPA fallback 404s from a dot-path install:\n${log}`);
    assert.match(body, /<div id="root">/, "served the real app shell, not an error page");
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
