// The one door all daemon logging goes through (R.4g grown up):
//
// - console: `[ISO] [component] level: message` lines. info+ always; debug
//   only with MIRAFOLD_DEBUG=1 (or the launcher's --verbose). Debug goes to
//   stderr so nothing can race a URL-shaped line into the stdout the
//   launcher parses.
// - file: a capped flight recorder (default ~/.local/state/mirafold/
//   mirafold.log; MIRAFOLD_LOG_FILE overrides the path, empty disables).
//   Rolls to `.1` at 5 MB — total footprint is bounded forever. It captures
//   info+ even when nobody is watching the terminal, so "attach your log
//   file" is the whole support instruction.
//
// Hard rules the sinks enforce by construction — the file must always be
// safe to paste into a public issue:
// - debug lines (the only level that may carry truncated payload fragments,
//   e.g. the registry's WireMsg trace) are CONSOLE-ONLY, never in the file;
// - print() (boot lines the user reads, including the ?token= URL and the
//   pairing code) is stdout-only, never persisted;
// - a logging failure disables the file sink, never the daemon.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** True when debug-level output is enabled (MIRAFOLD_DEBUG=1 / --verbose). */
export const verbose = Boolean(process.env.MIRAFOLD_DEBUG) || process.argv.includes("--verbose");

const MAX_LINE = 4_000; // payload-scale content has no business in a log line
const MAX_FILE_BYTES = 5_000_000; // roll here; one prior generation kept → ≤10 MB ever

function defaultLogFile(): string {
  const base =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
      : (process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"));
  return path.join(base, "mirafold", "mirafold.log");
}

/** Resolved log file path, or null when disabled (MIRAFOLD_LOG_FILE=""). */
export const logFile: string | null =
  process.env.MIRAFOLD_LOG_FILE === undefined
    ? defaultLogFile()
    : process.env.MIRAFOLD_LOG_FILE || null;

let fileBytes = -1; // unknown until the first write initializes the sink
let fileOk = logFile !== null;

function writeFile(line: string) {
  if (!fileOk || !logFile) return;
  try {
    if (fileBytes < 0) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fileBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    }
    if (fileBytes > MAX_FILE_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`); // replaces the prior generation
      fileBytes = 0;
    }
    const buf = `${line}\n`;
    fs.appendFileSync(logFile, buf);
    fileBytes += Buffer.byteLength(buf);
  } catch {
    fileOk = false;
  }
}

type Level = "error" | "warn" | "info" | "debug";
const CONSOLE: Record<Level, (s: string) => void> = {
  error: (s) => console.error(s),
  warn: (s) => console.warn(s),
  info: (s) => console.log(s),
  debug: (s) => console.error(s), // stderr — see the header
};

const clip = (msg: string) => (msg.length > MAX_LINE ? `${msg.slice(0, MAX_LINE)}…` : msg);

function emit(level: Level, component: string, msg: string) {
  const tag = level === "info" ? "" : ` ${level}:`;
  const line = `[${new Date().toISOString()}] [${component}]${tag} ${clip(msg)}`;
  if (level !== "debug" || verbose) CONSOLE[level](line);
  if (level !== "debug") writeFile(line);
}

export type Logger = {
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
  /** File-only info — the sanitized twin of a print() that carried a secret. */
  file(msg: string): void;
};

export function createLogger(component: string): Logger {
  return {
    error: (m) => emit("error", component, m),
    warn: (m) => emit("warn", component, m),
    info: (m) => emit("info", component, m),
    debug: (m) => emit("debug", component, m),
    file: (m) => writeFile(`[${new Date().toISOString()}] [${component}] ${clip(m)}`),
  };
}

/** Verbatim, stdout-only, never persisted — the boot lines the user reads,
 * including the ones carrying secrets (?token= URL, pairing code). */
export function print(msg: string) {
  console.log(msg);
}
