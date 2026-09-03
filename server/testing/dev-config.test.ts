import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  watch as fsWatch,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import concurrently from "concurrently";
import type { ConfigEnv, UserConfig } from "vite";
import makeViteConfig from "../../vite.config";
import {
  createServerRestartFilter,
  isServerSource,
  runWatchedProcess,
  watchRecursively,
} from "../../scripts/watch-server";
import { DEV_PORT_CONFLICT_EXIT_CODE } from "../env";
import { waitFor } from "./wait-for";

const silent = () => {};
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

const shellCommand = (...args: string[]): string =>
  args.map((arg) => `'${arg.replaceAll("'", `'"'"'`)}'`).join(" ");

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const countingChild = (fixture: string): { childFile: string; stateFile: string } => {
  const childFile = path.join(fixture, "child.mjs");
  const stateFile = path.join(fixture, "starts");
  writeFileSync(
    childFile,
    `import fs from "node:fs";\n` +
      `const file = ${JSON.stringify(stateFile)};\n` +
      `let starts = 0;\n` +
      `try { starts = Number(fs.readFileSync(file, "utf8")); } catch {}\n` +
      `fs.writeFileSync(file, String(starts + 1));\n` +
      `process.exit(2);\n`,
  );
  return { childFile, stateFile };
};

const startCount = (stateFile: string): number => {
  try {
    return Number(readFileSync(stateFile, "utf8"));
  } catch {
    return 0;
  }
};

test("the Vite WebSocket proxy follows the daemon PORT", async () => {
  assert.equal(typeof makeViteConfig, "function");
  const priorPort = process.env.PORT;
  process.env.PORT = "43123";
  try {
    const config = await (makeViteConfig as (env: ConfigEnv) => UserConfig)({
      command: "serve",
      mode: "test",
      isSsrBuild: false,
      isPreview: false,
    });
    const wsProxy = config.server?.proxy?.["/ws"];
    if (!wsProxy || typeof wsProxy === "string") {
      assert.fail("expected the /ws proxy to use an options object");
    }
    assert.equal(wsProxy.target, "ws://127.0.0.1:43123");
  } finally {
    if (priorPort === undefined) delete process.env.PORT;
    else process.env.PORT = priorPort;
  }
});

test("the Vite WebSocket proxy uses the daemon fallback for a malformed PORT", async () => {
  assert.equal(typeof makeViteConfig, "function");
  const priorPort = process.env.PORT;
  process.env.PORT = "not-a-port";
  try {
    const config = await (makeViteConfig as (env: ConfigEnv) => UserConfig)({
      command: "serve",
      mode: "test",
      isSsrBuild: false,
      isPreview: false,
    });
    const wsProxy = config.server?.proxy?.["/ws"];
    if (!wsProxy || typeof wsProxy === "string") {
      assert.fail("expected the /ws proxy to use an options object");
    }
    assert.equal(wsProxy.target, "ws://127.0.0.1:3000");
  } finally {
    if (priorPort === undefined) delete process.env.PORT;
    else process.env.PORT = priorPort;
  }
});

test("a real strict-port failure stops the dev watcher and its sibling", {
  skip: process.platform === "win32" ? "the development scripts require a POSIX shell" : false,
}, async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-dev-watch-port-"));
  const siblingFile = path.join(fixture, "web.mjs");
  const siblingPidFile = path.join(fixture, "web.pid");
  writeFileSync(
    siblingFile,
    `import fs from "node:fs";\n` +
      `fs.writeFileSync(${JSON.stringify(siblingPidFile)}, String(process.pid));\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  let commands: ReturnType<typeof concurrently>["commands"] = [];
  try {
    const address = blocker.address();
    assert.ok(address && typeof address !== "string");
    const run = concurrently(
      [
        {
          name: "server",
          command: shellCommand(
            process.execPath,
            "--import",
            import.meta.resolve("tsx"),
            path.join(projectRoot, "scripts", "watch-server.ts"),
          ),
          // server/project-env-loader resolves from cwd. This freshly created
          // directory contains no project configuration file.
          cwd: fixture,
          env: {
            PORT: String(address.port),
            MIRAFOLD_STRICT_PORT: "1",
            MIRAFOLD_TOKEN: "",
            MIRAFOLD_RELAY_URL: "off",
            MIRAFOLD_LOCAL_DISCOVERY: "off",
            MIRAFOLD_LOG_FILE: "",
            MIRAFOLD_SESSION_DIR: path.join(fixture, "sessions"),
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_AUTH_TOKEN: "",
            ANTHROPIC_BASE_URL: "",
            OPENAI_API_KEY: "",
            GEMINI_API_KEY: "",
            GOOGLE_API_KEY: "",
            CODEX_HOME: path.join(fixture, "no-codex-home"),
            CLAUDE_CONFIG_DIR: path.join(fixture, "no-claude-home"),
            OPENCODE_BIN: path.join(fixture, "no-opencode"),
          },
        },
        {
          name: "web",
          command: shellCommand(process.execPath, siblingFile),
          cwd: fixture,
        },
      ],
      {
        killOthersOn: ["failure"],
        outputStream,
      },
    );
    commands = run.commands;
    await waitFor(
      () => {
        try {
          return Number(readFileSync(siblingPidFile, "utf8")) > 0;
        } catch {
          return false;
        }
      },
      "the sibling dev process",
    );
    await assert.rejects(run.result);
    assert.match(output, new RegExp(`port ${address.port} is already in use`));
    assert.match(output, /the daemon port is unavailable; stopping the dev stack/);
    const siblingPid = Number(readFileSync(siblingPidFile, "utf8"));
    await waitFor(() => !processExists(siblingPid), "the sibling dev process to stop");
  } finally {
    for (const command of commands) command.kill("SIGKILL");
    try {
      const siblingPid = Number(readFileSync(siblingPidFile, "utf8"));
      if (processExists(siblingPid)) process.kill(siblingPid, "SIGKILL");
    } catch {}
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the dev watcher exits for its reserved strict-port code", async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-dev-watch-code-"));
  const watched = path.join(fixture, "watched");
  mkdirSync(watched);
  try {
    const result = await runWatchedProcess({
      watchRoot: watched,
      command: process.execPath,
      args: ["-e", `process.exit(${DEV_PORT_CONFLICT_EXIT_CODE})`],
      stdio: "ignore",
      log: silent,
    });
    assert.equal(result, 1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("ordinary server failures wait for an edit and restart", async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-dev-watch-retry-"));
  const watched = path.join(fixture, "watched");
  const { childFile, stateFile } = countingChild(fixture);
  const triggerFile = path.join(watched, "source.ts");
  mkdirSync(watched);
  writeFileSync(triggerFile, "first");
  const controller = new AbortController();
  let settled = false;
  const result = runWatchedProcess({
    watchRoot: watched,
    command: process.execPath,
    args: [childFile],
    stdio: "ignore",
    signal: controller.signal,
    restartDelayMs: 10,
    log: silent,
  }).finally(() => {
    settled = true;
  });
  try {
    await waitFor(
      () => startCount(stateFile) === 1,
      "the first watched child start",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false);

    writeFileSync(triggerFile, "second");
    await waitFor(
      () => startCount(stateFile) === 2,
      "the watched child restart",
    );
    controller.abort();
    assert.equal(await result, 0);
  } finally {
    controller.abort();
    await result;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("runtime output under the server tree does not restart the dev server", async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-dev-watch-output-"));
  const watched = path.join(fixture, "watched");
  const { childFile, stateFile } = countingChild(fixture);
  const sourceFile = path.join(watched, "source.ts");
  const logFile = path.join(watched, "runtime.ts");
  mkdirSync(watched);
  writeFileSync(sourceFile, "first");
  writeFileSync(logFile, "first\n");
  const shouldRestart = createServerRestartFilter(
    watched,
    fixture,
    path.join("watched", "runtime.ts"),
  );
  assert.equal(isServerSource("runtime.ts"), true);
  assert.equal(shouldRestart("runtime.ts"), false);
  assert.equal(shouldRestart("source.ts"), true);

  const controller = new AbortController();
  const result = runWatchedProcess({
    watchRoot: watched,
    shouldRestart,
    command: process.execPath,
    args: [childFile],
    stdio: "ignore",
    signal: controller.signal,
    restartDelayMs: 10,
    log: silent,
  });
  try {
    await waitFor(() => startCount(stateFile) === 1, "the initial output-filter child start");
    appendFileSync(logFile, "second\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(startCount(stateFile), 1);

    writeFileSync(sourceFile, "second");
    await waitFor(() => startCount(stateFile) === 2, "the source-triggered child restart");
    controller.abort();
    assert.equal(await result, 0);
  } finally {
    controller.abort();
    await result;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("an atomically replaced watched file keeps restarting after the first save", async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-dev-watch-file-"));
  const watched = path.join(fixture, "watched");
  const configDir = path.join(fixture, "config");
  const configFile = path.join(configDir, "package.json");
  const { childFile, stateFile } = countingChild(fixture);
  mkdirSync(watched);
  mkdirSync(configDir);
  writeFileSync(configFile, "{}");
  const controller = new AbortController();
  const result = runWatchedProcess({
    watchRoot: watched,
    watchFiles: [configFile],
    command: process.execPath,
    args: [childFile],
    stdio: "ignore",
    signal: controller.signal,
    restartDelayMs: 10,
    log: silent,
  });
  const replaceConfig = (contents: string): void => {
    const replacement = path.join(configDir, "package.next");
    writeFileSync(replacement, contents);
    renameSync(replacement, configFile);
  };
  try {
    await waitFor(
      () => startCount(stateFile) === 1,
      "the initial watched-file child start",
    );
    replaceConfig('{"version":1}');
    await waitFor(
      () => startCount(stateFile) === 2,
      "the first atomic-save restart",
    );
    replaceConfig('{"version":2}');
    await waitFor(
      () => startCount(stateFile) === 3,
      "the second atomic-save restart",
    );
    controller.abort();
    assert.equal(await result, 0);
  } finally {
    controller.abort();
    await result;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a rapidly created nested source directory remains watched", async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-dev-watch-nested-"));
  const watched = path.join(fixture, "watched");
  const { childFile, stateFile } = countingChild(fixture);
  mkdirSync(watched);
  const controller = new AbortController();
  const result = runWatchedProcess({
    watchRoot: watched,
    command: process.execPath,
    args: [childFile],
    stdio: "ignore",
    signal: controller.signal,
    restartDelayMs: 25,
    log: silent,
  });
  try {
    await waitFor(() => startCount(stateFile) === 1, "the initial nested-watch child start");
    const deep = path.join(watched, "a", "b", "c");
    const source = path.join(deep, "source.ts");
    mkdirSync(deep, { recursive: true });
    writeFileSync(source, "first");
    await waitFor(() => startCount(stateFile) >= 2, "the nested-source creation restart");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterCreation = startCount(stateFile);

    writeFileSync(source, "second");
    await waitFor(
      () => startCount(stateFile) > afterCreation,
      "the later nested-source edit restart",
    );
    controller.abort();
    assert.equal(await result, 0);
  } finally {
    controller.abort();
    await result;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the portable watcher fallback follows rapidly created nested directories", async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-dev-watch-fallback-"));
  const watched = path.join(fixture, "watched");
  mkdirSync(watched);
  const changes: Array<string | null> = [];
  let watchError: unknown;
  let nativeAttempted = false;
  let attachmentRaceInjected = false;
  const vanishing = path.join(watched, "vanishing");
  mkdirSync(vanishing);
  const fallbackError = Object.assign(new Error("recursive watch unavailable"), {
    code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
  });
  const handle = watchRecursively(
    watched,
    (relativePath) => changes.push(relativePath),
    (error) => {
      watchError = error;
    },
    {
      recursive: () => {
        nativeAttempted = true;
        throw fallbackError;
      },
      directory: (directory, listener) => {
        if (directory === vanishing && !attachmentRaceInjected) {
          attachmentRaceInjected = true;
          rmSync(vanishing, { recursive: true, force: true });
          throw Object.assign(new Error("nested directory disappeared"), { code: "ENOENT" });
        }
        return fsWatch(directory, listener);
      },
    },
  );
  try {
    assert.equal(nativeAttempted, true);
    assert.equal(attachmentRaceInjected, true);
    assert.equal(watchError, undefined);
    const runtimeOutput = path.join(watched, "runtime", "nested", "output.log");
    mkdirSync(path.dirname(runtimeOutput), { recursive: true });
    writeFileSync(runtimeOutput, "runtime output");
    await waitFor(() => changes.length > 0, "the fallback runtime-tree change");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(changes.some(isServerSource), false);
    changes.length = 0;

    const deep = path.join(watched, "a", "b", "c");
    const source = path.join(deep, "source.ts");
    mkdirSync(deep, { recursive: true });
    writeFileSync(source, "first");
    await waitFor(() => changes.some(isServerSource), "the fallback nested-tree change");
    await new Promise((resolve) => setTimeout(resolve, 100));
    changes.length = 0;

    writeFileSync(source, "second");
    await waitFor(
      () => changes.includes(path.join("a", "b", "c", "source.ts")),
      "the fallback nested-source edit",
    );

    changes.length = 0;
    const replaced = path.join(watched, "a", "b", "replaced-c");
    renameSync(deep, replaced);
    mkdirSync(deep);
    writeFileSync(source, "replacement");
    await waitFor(() => changes.length > 0, "the fallback directory replacement");
    await new Promise((resolve) => setTimeout(resolve, 100));
    changes.length = 0;

    writeFileSync(source, "after replacement");
    await waitFor(
      () => changes.includes(path.join("a", "b", "c", "source.ts")),
      "the fallback replacement-directory edit",
    );
    assert.equal(watchError, undefined);
  } finally {
    handle.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("stopping the dev watcher force-stops a server that ignores SIGTERM", async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-dev-watch-stop-"));
  const watched = path.join(fixture, "watched");
  const pidFile = path.join(fixture, "pid");
  const childFile = path.join(fixture, "child.mjs");
  mkdirSync(watched);
  writeFileSync(
    childFile,
    `import fs from "node:fs";\n` +
      `process.on("SIGTERM", () => {});\n` +
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  const controller = new AbortController();
  const result = runWatchedProcess({
    watchRoot: watched,
    command: process.execPath,
    args: [childFile],
    stdio: "ignore",
    signal: controller.signal,
    forceKillAfterMs: 100,
    log: silent,
  });
  try {
    await waitFor(() => {
      try {
        return Number(readFileSync(pidFile, "utf8")) > 0;
      } catch {
        return false;
      }
    }, "the watched child pid");
    const pid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    assert.equal(await result, 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    controller.abort();
    await result;
    rmSync(fixture, { recursive: true, force: true });
  }
});
