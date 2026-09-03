import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_PORT_CONFLICT_EXIT_CODE } from "../server/env";

const THIS_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(THIS_FILE), "..");
const SERVER_ROOT = path.join(PROJECT_ROOT, "server");
const SERVER_ENTRY = path.join(SERVER_ROOT, "index.ts");
const PACKAGE_JSON = path.join(PROJECT_ROOT, "package.json");
const TSX_IMPORT = import.meta.resolve("tsx");

const SERVER_TEST_PATH =
  /(^|\/)testing(\/|$)|\.(?:test|itest|e2e|uitest|ltest)\.ts$/;

const isServerSource = (relativePath: string | null): boolean =>
  relativePath === null || !SERVER_TEST_PATH.test(relativePath.replaceAll("\\", "/"));

export type WatchedProcessOptions = {
  watchRoot: string;
  watchFiles?: string[];
  shouldRestart?: (relativePath: string | null) => boolean;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: SpawnOptions["stdio"];
  signal?: AbortSignal;
  label?: string;
  restartDelayMs?: number;
  forceKillAfterMs?: number;
  log?: (message: string) => void;
};

const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/** Stop one watched child completely before its replacement starts. */
const stopChild = (child: ChildProcess, forceKillAfterMs: number): Promise<void> => {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardStop);
      resolve();
    };
    const hardStop = setTimeout(() => {
      if (!hasExited(child)) child.kill("SIGKILL");
    }, forceKillAfterMs);
    child.once("close", finish);
    child.kill("SIGTERM");
  });
};

/**
 * Run a process under a source watcher. Ordinary child failures wait for the
 * next edit, matching `tsx watch`; the daemon's explicit strict-port failure
 * tears the watcher down so the parent `concurrently` process also stops Vite.
 */
export async function runWatchedProcess(options: WatchedProcessOptions): Promise<number> {
  const label = options.label ?? "process";
  const log = options.log ?? ((message: string) => console.error(message));
  const restartDelayMs = options.restartDelayMs ?? 75;
  const forceKillAfterMs = options.forceKillAfterMs ?? 3_000;
  let child: ChildProcess | undefined;
  const fileWatchers: FSWatcher[] = [];
  let restartTimer: NodeJS.Timeout | undefined;
  let restarting = false;
  let restartQueued = false;
  let settled = false;
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((resolve) => {
    resolveResult = resolve;
  });

  const finish = async (code: number, message?: string): Promise<void> => {
    if (settled) return;
    settled = true;
    clearTimeout(restartTimer);
    restartTimer = undefined;
    if (message) log(message);
    for (const fileWatcher of fileWatchers) fileWatcher.close();
    fileWatchers.length = 0;
    const activeChild = child;
    child = undefined;
    if (activeChild) await stopChild(activeChild, forceKillAfterMs);
    resolveResult(code);
  };

  const launch = (): void => {
    if (settled) return;
    const launched = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
    });
    child = launched;
    launched.once("error", (error) => {
      void finish(1, `[mirafold] could not start the ${label}: ${error.message}`);
    });
    launched.once("exit", (code, signal) => {
      if (child === launched) child = undefined;
      if (settled) return;
      if (code === DEV_PORT_CONFLICT_EXIT_CODE) {
        void finish(1, "[mirafold] the daemon port is unavailable; stopping the dev stack");
        return;
      }
      if (restarting) return;
      const reason = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      log(`[mirafold] ${label} exited with ${reason}; waiting for a source change`);
    });
  };

  const restart = async (): Promise<void> => {
    if (settled) return;
    if (restarting) {
      restartQueued = true;
      return;
    }
    restarting = true;
    const activeChild = child;
    if (activeChild) await stopChild(activeChild, forceKillAfterMs);
    if (!settled) launch();
    restarting = false;
    if (restartQueued && !settled) {
      restartQueued = false;
      scheduleRestart();
    }
  };

  const scheduleRestart = (): void => {
    if (settled) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void restart();
    }, restartDelayMs);
  };

  const onAbort = () => void finish(0);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) void finish(0);

  try {
    if (settled) return result;
    const rootWatcher = watch(options.watchRoot, { recursive: true }, (_event, changed) => {
      const relativePath = changed?.toString() ?? null;
      if (options.shouldRestart?.(relativePath) ?? true) scheduleRestart();
    });
    rootWatcher.once("error", (error) => {
      void finish(1, `[mirafold] ${label} source watcher failed: ${error.message}`);
    });
    fileWatchers.push(rootWatcher);

    for (const file of options.watchFiles ?? []) {
      // Watch the directory, not the file's current inode. Editors commonly
      // save by renaming a replacement over the original; an inode watch fires
      // once for that replacement and then stays attached to the dead file.
      const filename = path.basename(file);
      const fileWatcher = watch(path.dirname(file), (_event, changed) => {
        if (changed === null || changed.toString() === filename) scheduleRestart();
      });
      fileWatcher.once("error", (error) => {
        void finish(1, `[mirafold] ${label} source watcher failed: ${error.message}`);
      });
      fileWatchers.push(fileWatcher);
    }
    launch();
    return await result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await finish(1, `[mirafold] could not watch ${label} sources: ${detail}`);
    return result;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    process.exitCode = await runWatchedProcess({
      watchRoot: SERVER_ROOT,
      watchFiles: [PACKAGE_JSON],
      shouldRestart: isServerSource,
      command: process.execPath,
      args: ["--import", TSX_IMPORT, SERVER_ENTRY],
      cwd: process.cwd(),
      env: process.env,
      signal: controller.signal,
      label: "server",
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
