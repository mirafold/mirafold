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
// - every logged line is scrubbed of credential-shaped text (see scrub()),
//   because adapters pass third-party engine stderr through verbatim;
// - a logging failure disables the file sink, never the daemon.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { envFlag } from "./env";

/** True when debug-level output is enabled (MIRAFOLD_DEBUG=1 / --verbose).
 *  MIRAFOLD_DEBUG=0 and =false mean OFF (2026-07-29 bughunt — Boolean("0")
 *  is true, so setting 0 to disable debug used to enable it). */
export const verbose = envFlag(process.env.MIRAFOLD_DEBUG) || process.argv.includes("--verbose");

const MAX_LINE = 4_000; // payload-scale content has no business in a log line
const MAX_FILE_BYTES = 5_000_000; // roll here; one prior generation kept → ≤10 MB ever

/** The daemon's platform state directory (win32 LOCALAPPDATA / XDG state) —
 *  the one home for daemon-kept files: the log here, the trusted-repos list
 *  in git-trust.ts. */
export function stateDir(): string {
  const base =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
      : (process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"));
  return path.join(base, "mirafold");
}

function defaultLogFile(): string {
  return path.join(stateDir(), "mirafold.log");
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

/**
 * Last-line defense for the "safe to paste into a public issue" rule above.
 *
 * Our OWN secrets never reach here — print() keeps the ?token= URL and the
 * pairing code on stdout, and their file twins are hand-elided. The exposure
 * is third-party text we pass through verbatim: an adapter's `error` WireMsg
 * is written to the flight recorder (registry.ts), and one producer of those
 * is a raw tail of engine stderr. Gemini's REST API authenticates with the key
 * in the QUERY STRING, and CLI/SDK failure paths routinely echo the failing
 * request URL — so a plausible crash writes a live API key into the exact file
 * we tell users to attach to bug reports (2026-07-27 audit).
 *
 * Patterns are deliberately shaped (known credential prefixes, named query
 * params) rather than entropy-guessing, so ordinary log text is never mangled.
 * Exported for the Tier-1 test.
 */
export function scrub(msg: string): string {
  return (
    msg
      // URL userinfo. Configured endpoints are allowed to contain it, and an
      // SDK failure can echo the destination even when no Authorization
      // header is present.
      .replace(/(https?:\/\/)[^\s/"'`@]+@/gi, "$1[redacted]@")
      // Any URL-style query value is potentially a signed/credential value;
      // preserving parameter names keeps the diagnostic useful. Requiring ?
      // or & avoids mangling ordinary `key=value` prose.
      .replace(/([?&][A-Za-z0-9_.~-]{1,80}=)[^&\s"'`#]+/g, "$1[redacted]")
      // Fragments do not reach HTTP, but a raw configured URL may use one as
      // local secret-bearing metadata and logs are promised paste-safe.
      .replace(/(https?:\/\/[^\s"'`#]+)#[^\s"'`]+/gi, "$1#[redacted]")
      // ?key=… / &api_key=… / ?access_token=… — the Gemini-style query credential
      .replace(/([?&](?:key|api[-_]?key|access[-_]?token|auth|token)=)[^&\s"'`]+/gi, "$1[redacted]")
      // Authorization headers echoed into an error string
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
      // OpenAI / Anthropic / OpenRouter style: sk-…, sk-ant-…, sk-or-…
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-key]")
      // Google API keys
      .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted-key]")
      // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted-key]")
      // AWS access key ids (Bedrock — an engine Claude Code supports; the
      // adapter passes process.env through, so a session echoing SigV4 or a
      // key id into engine stderr must not land in the flight recorder —
      // audit 2026-08-13).
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-key]")
      // Google Vertex OAuth access tokens (ya29.…)
      .replace(/\bya29\.[0-9A-Za-z_-]{20,}/g, "[redacted-key]")
  );
}

/** Scrub a provider diagnostic while also removing this session's exact
 * selected endpoint (including a secret-bearing path). URL normalization can
 * add a trailing slash, so cover both operator and normalized spellings. */
export function scrubSelectedEndpoint(msg: string, endpoint?: string): string {
  let redacted = msg;
  if (endpoint) {
    const spellings = new Set([endpoint]);
    try {
      spellings.add(new URL(endpoint).href);
    } catch {
      // The exact raw spelling below still gets removed.
    }
    for (const spelling of spellings) {
      if (spelling) redacted = redacted.split(spelling).join("[selected endpoint]");
    }
  }
  return scrub(redacted);
}

/** Scrub BEFORE clipping — clipping first could sever a credential mid-string
 *  and leave the surviving half unmatched. */
const sanitize = (msg: string) => clip(scrub(msg));

function emit(level: Level, component: string, msg: string) {
  const tag = level === "info" ? "" : ` ${level}:`;
  const line = `[${new Date().toISOString()}] [${component}]${tag} ${sanitize(msg)}`;
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
    file: (m) => writeFile(`[${new Date().toISOString()}] [${component}] ${sanitize(m)}`),
  };
}

/** Verbatim, stdout-only, never persisted — the boot lines the user reads,
 * including the ones carrying secrets (?token= URL, pairing code). */
export function print(msg: string) {
  console.log(msg);
}
