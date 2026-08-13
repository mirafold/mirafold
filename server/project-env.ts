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
  "MAX_THINKING_TOKENS",

  // Daemon, local-model, logging, and relay configuration.
  "PORT",
  "MIRAFOLD_TOKEN",
  "MIRAFOLD_DEBUG",
  // NOT MIRAFOLD_LOG_FILE: it's a daemon-OPERATOR setting (where the daemon
  // writes its own log), not project data. Honoring it from a checkout's
  // .env gave a hostile repo an arbitrary file-APPEND primitive — point it at
  // ~/.bashrc or a crontab, and since log lines can carry engine stderr
  // verbatim, an embedded newline writes an unprefixed line (audit
  // 2026-08-13). That is outside the disclosed set of what a project .env may
  // do (endpoints, relay access, resource limits, auth posture).
  "MIRAFOLD_LOCAL_ENDPOINTS",
  "MIRAFOLD_LOCAL_DISCOVERY",
  "MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS",
  "MIRAFOLD_RELAY_URL",
  "MIRAFOLD_APP_URL",
  "MIRAFOLD_RELAY_CODE",
  "MIRAFOLD_LICENSE_KEY",
  "MIRAFOLD_ENTITLEMENT_URL",
  "MIRAFOLD_ENTITLEMENT_TOKEN",

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

// Keep provenance, never a duplicate of secret contents: endpoint
// authentication must distinguish an operator-supplied daemon value from one
// a checkout supplied through the constrained project configuration.
const loadedProjectKeys = new Set<string>();

/** Did the constrained project configuration supply this process.env key at
 * startup? Parent-process values always win and therefore never enter it. */
export function wasLoadedFromProjectEnv(key: string): boolean {
  return loadedProjectKeys.has(key);
}

/** Load supported project settings without letting the checkout modify process
 *  identity. Existing values win, matching Node's process.loadEnvFile() rule:
 *  an explicit parent-process value always beats the file. Missing, unreadable,
 *  or malformed optional files leave the target untouched. */
export function loadProjectEnv(
  file = ".env",
  target: NodeJS.ProcessEnv = process.env,
): void {
  let parsed: NodeJS.Dict<string>;
  try {
    parsed = parseEnv(readFileSync(file, "utf8"));
  } catch {
    return;
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined && PROJECT_ENV_KEYS.has(key) && target[key] === undefined) {
      target[key] = value;
      if (target === process.env) loadedProjectKeys.add(key);
    }
  }
}
