// A checkout's .env is application data, not parent-process authority.
// Import only settings Mirafold deliberately supports there; executable
// overrides, PATH/shell controls, runtime loader hooks, and arbitrary project
// variables stay available only when the operator supplied them before launch.

import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export const PROJECT_ENV_KEYS: ReadonlySet<string> = new Set([
  // Agent selection, credentials, endpoints, and model choices.
  "MIRAFOLD_AGENT",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "DEFAULT_MODEL",
  "OPENAI_API_KEY",
  "CODEX_MODEL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_MODEL",
  "OPENCODE_MODEL",
  "MAX_THINKING_TOKENS",

  // Daemon, local-model, logging, and relay configuration.
  "PORT",
  "MIRAFOLD_DEBUG",
  // NOT MIRAFOLD_LOG_FILE: it's a daemon-OPERATOR setting (where the daemon
  // writes its own log), not project data. Honoring it from a checkout's
  // .env would give a hostile repo an arbitrary file-APPEND primitive — point
  // it at ~/.bashrc or a crontab, and since log lines can carry engine stderr
  // verbatim, an embedded newline writes an unprefixed line. That is outside
  // the disclosed set of what a project .env may do (endpoints, relay access,
  // resource limits).
  // NOT MIRAFOLD_TOKEN either: the auth posture is the operator's, never a
  // checkout's. An EMPTY value disables auth (index.ts), and `.env.example`
  // is conventionally copied to `.env` verbatim — so a bare `MIRAFOLD_TOKEN=`
  // line, or a hostile checkout carrying one, would silently open the daemon
  // to any page on localhost (audit 2026-08-26). Disabling or pinning the
  // token needs the parent environment, as `yarn dev:server` does.
  "MIRAFOLD_LOCAL_DISCOVERY",
  "MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS",
  // NOT the relay / entitlement family, and NOT MIRAFOLD_LOCAL_ENDPOINTS:
  // a checkout's .env configures the AGENT (its credentials, endpoints,
  // model), never the daemon's own identity, credentials, or where it
  // dials. Three lines in a hostile repo's .env otherwise POSTed the user's
  // real license key to an attacker host, dialed the attacker's relay with
  // a pairing code the attacker wrote, and presented all of it as the
  // daemon's own boot output (audit 2026-08-26, probed). A checkout-added
  // "local" endpoint would likewise be offered as a discovered local server
  // and carry the conversation off-machine. Operator environment only.

  // Documented resource limits.
  "MAX_WS_PAYLOAD",
  "SESSION_BUFFER_MAX_BYTES",
  "SESSION_IDLE_TIMEOUT_MS",
  "DELTA_COALESCE_MS",
  "MAX_SESSIONS",
  "PERMISSION_TIMEOUT_MS",
  "TOOL_OUTPUT_CAP_BYTES",
  "BANG_CONTEXT_CAP",
  "MAX_REMOTE_VIEWPORTS",
  "RELAY_VIEWPORT_IDLE_MS",
]);

/** Keys a checkout's .env may name but the daemon deliberately refuses (see
 *  the allowlist's comments): named here so the refusal is announced. */
const OPERATOR_ONLY_KEYS: ReadonlySet<string> = new Set([
  "MIRAFOLD_TOKEN",
  "MIRAFOLD_LOG_FILE",
  "MIRAFOLD_RELAY_URL",
  "MIRAFOLD_RELAY_CODE",
  "MIRAFOLD_APP_URL",
  "MIRAFOLD_LICENSE_KEY",
  "MIRAFOLD_ENTITLEMENT_URL",
  "MIRAFOLD_ENTITLEMENT_TOKEN",
  "MIRAFOLD_LOCAL_ENDPOINTS",
]);

// Keep provenance, never a duplicate of secret contents: endpoint
// authentication must distinguish an operator-supplied daemon value from one
// a checkout supplied through the constrained project configuration.
const loadedProjectKeys = new Set<string>();

/** Did the constrained project configuration supply this process.env key at
 * startup? Parent-process values always win and therefore never enter it. */
export function wasLoadedFromProjectEnv(key: string): boolean {
  return loadedProjectKeys.has(key);
}

/** The environment a `!` command inherits: the daemon's own, minus every key
 *  the checkout's .env supplied. Those values are the AGENT's configuration
 *  (credentials, endpoints, model pins) that Mirafold imported for itself; a
 *  terminal never exports a project's .env into the user's shell, and `!`
 *  output is broadcast to every viewport and checkpointed verbatim, so an
 *  `!env` must not turn an imported key into transcript. Parent-supplied
 *  values pass through untouched — that IS the user's shell environment. */
export function shellEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !loadedProjectKeys.has(key)) out[key] = value;
  }
  return out;
}

/** Load supported project settings without letting the checkout modify process
 *  identity. Existing values win, matching Node's process.loadEnvFile() rule:
 *  an explicit parent-process value always beats the file. Missing, unreadable,
 *  or malformed optional files leave the target untouched. */
export function loadProjectEnv(
  file = ".env",
  target: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): void {
  let parsed: NodeJS.Dict<string>;
  try {
    parsed = parseEnv(readFileSync(file, "utf8"));
  } catch {
    return;
  }

  for (const [key, value] of Object.entries(parsed)) {
    // Silently ignoring a key the older .env.example invited would read as
    // "set, nothing happened" — say why it did nothing.
    if (OPERATOR_ONLY_KEYS.has(key)) {
      warn(`mirafold: ${file}: ${key} is an operator setting and is not read from a checkout's .env — export it in the parent environment instead`);
      continue;
    }
    if (value !== undefined && PROJECT_ENV_KEYS.has(key) && target[key] === undefined) {
      target[key] = value;
      if (target === process.env) loadedProjectKeys.add(key);
    }
  }
}
