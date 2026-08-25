import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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
import {
  browserOpenCommand,
  browserOpenEnvironment,
  openBrowser,
} from "../../bin/browser-open.js";
import { SCRUBBED_CREDENTIAL_ENV } from "./itest-harness";

// Tier-3 (`yarn test:e2e`, needs a fresh `yarn build`): host browser opening
// must use OS identity, never npm's project-local PATH; it also must not tie the
// browser to the user's terminal or leak the daemon's credential environment.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAUNCHER = path.join(ROOT, "bin", "mirafold.js");
const DAEMON = path.join(ROOT, "dist-server", "index.js");

// /proc: the process-state guarantee is exercised on Linux, the CI platform.
const linuxOnly = { skip: process.platform !== "linux" };

async function stopProcessGroup(child: ChildProcess): Promise<void> {
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
}

test("launcher ignores project PATH when resolving host browser chrome", () => {
  const inspected: string[] = [];
  const fakePath = "/hostile/project/node_modules/.bin";
  const url = "http://127.0.0.1:3000/?token=test";
  const command = browserOpenCommand(
    url,
    "linux",
    { PATH: fakePath },
    (file) => {
      inspected.push(file);
      return file === "/usr/bin/xdg-open";
    },
  );
  assert.deepEqual(command, {
    file: "/usr/bin/xdg-open",
    args: [url],
  });
  assert.ok(inspected.every((file) => path.isAbsolute(file)));
  assert.ok(inspected.every((file) => !file.startsWith(fakePath)));
  assert.deepEqual(browserOpenCommand(url, "darwin", { PATH: fakePath }, () => true), {
    file: "/usr/bin/open",
    args: [url],
  });
  assert.deepEqual(
    browserOpenCommand(
      `${url}&calc|whoami`,
      "win32",
      { PATH: fakePath, SystemRoot: "C:\\Windows" },
      () => true,
    ),
    {
      file: "C:\\Windows\\explorer.exe",
      args: [`${url}&calc|whoami`],
    },
  );
  assert.equal(browserOpenCommand(url, "win32", { PATH: fakePath }, () => true), undefined);
});

test("browser opener is detached, neutral-cwd, and credential-scrubbed", linuxOnly, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "genui-browser-open-"));
  const record = path.join(tmp, "opener-record");
  const opener = path.join(tmp, "trusted-test-opener");
  writeFileSync(
    opener,
    `#!/bin/bash
fd0=$(readlink /proc/$$/fd/0)
fd1=$(readlink /proc/$$/fd/1)
fd2=$(readlink /proc/$$/fd/2)
sid=$(ps -o sid= -p $$ | tr -d " ")
if [[ -v OPENAI_API_KEY || -v MIRAFOLD_TEST_BROWSER_SECRET ]]; then secret=present; else secret=absent; fi
printf 'args=%s\\nfd0=%s\\nfd1=%s\\nfd2=%s\\npid=%s\\nsid=%s\\nsecret=%s\\ncwd=%s\\n' \\
  "$*" "$fd0" "$fd1" "$fd2" "$$" "$sid" "$secret" "$PWD" > ${JSON.stringify(record)}
`,
  );
  chmodSync(opener, 0o755);
  const url = "http://127.0.0.1:3000/?token=browser-open-test";
  openBrowser(url, {
    platform: "linux",
    env: {
      ...process.env,
      PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ""}`,
      OPENAI_API_KEY: "must-not-cross",
      MIRAFOLD_TEST_BROWSER_SECRET: "must-not-cross",
    },
    command: { file: opener, args: [url] },
  });

  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !existsSync(record)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(record), "opener never ran");
    const got = Object.fromEntries(
      readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]),
    );
    assert.equal(got.args, url);
    assert.equal(got.fd0, "/dev/null");
    assert.equal(got.fd1, "/dev/null");
    assert.equal(got.fd2, "/dev/null");
    assert.equal(got.sid, got.pid, "opener is its own session leader (detached)");
    assert.equal(got.secret, "absent");
    assert.equal(got.cwd, os.homedir());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("browser opener environment never carries PATH overrides or credentials", () => {
  const env = browserOpenEnvironment(
    {
      PATH: "/project/node_modules/.bin:/attacker/bin",
      DISPLAY: ":1",
      OPENAI_API_KEY: "must-not-cross",
      BROWSER: "/project/browser",
      LD_PRELOAD: "/project/hook.so",
    },
    "linux",
  );
  assert.equal(env.DISPLAY, ":1");
  assert.match(env.PATH, /^\/usr\/bin:/);
  assert.equal("OPENAI_API_KEY" in env, false);
  assert.equal("BROWSER" in env, false);
  assert.equal("LD_PRELOAD" in env, false);
});

test("the official launcher warns when npm exec supplies project binaries", async () => {
  assert.ok(existsSync(DAEMON), "dist-server missing — test:e2e must run `yarn build` first");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "genui-npx-warning-"));
  const child = spawn(process.execPath, [LAUNCHER, "--no-open"], {
    cwd: tmp,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...SCRUBBED_CREDENTIAL_ENV,
      npm_command: "exec",
      npm_lifecycle_event: "npx",
      PORT: String(3910 + Math.floor(Math.random() * 70)),
    },
  });
  let log = "";
  child.stdout.on("data", (data: Buffer) => (log += data));
  child.stderr.on("data", (data: Buffer) => (log += data));
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !/http:\/\/127\.0\.0\.1:\d+\//.test(log)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(log, /npx exposes executables from the current project's node_modules/i);
    assert.match(log, /installed command avoids package shadowing/i);
    assert.match(log, /review or rename the checkout's \.env/i);
    assert.match(log, /http:\/\/127\.0\.0\.1:\d+\//);
  } finally {
    await stopProcessGroup(child);
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The SPA fallback must survive a global install under a DOT-DIRECTORY.
// `npm i -g` unpacks into the active Node's prefix, and for nvm (~/.nvm/…),
// asdf, volta and fnm that path carries a dot-segment. send's default
// dotfiles:"ignore" policy inspects EVERY segment of an ABSOLUTE path, so
// `sendFile(join(DIST, "index.html"))` 404'd there while `GET /` kept working
// (express.static passes a root, confining the check to the request path).
// Reported 2026-07-30 from a real tester-style install: agent picker died on the
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
    await stopProcessGroup(child);
    rmSync(tmp, { recursive: true, force: true });
  }
});
