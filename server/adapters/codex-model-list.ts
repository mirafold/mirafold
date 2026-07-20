// The Codex model catalog, asked of Codex itself (V.2's /model parity).
//
// Terminal Codex's /model picker is interactive TUI chrome the headless SDK
// can't reach, but the LIST it shows comes from the binary's own
// `app-server` JSON-RPC surface (`model/list` — the same catalog, same
// order, same descriptions; verified live against the terminal picker
// side-by-side). We spawn a codex binary one-shot, do the initialize
// handshake, ask, and kill it — so the answer is exactly what a terminal
// running that binary would show, never a hardcoded or version-skewed copy.
//
// Note the deliberate binary choice: the PATH `codex` (the user's install)
// by default — the catalog is filtered per client version, and picker parity
// means the user's version's answer. An explicit `bin` asks a different
// binary instead (the SDK's vendored engine, whose version-correct default
// the provider-binding path needs).

import { agentBin } from "./types";
import { jsonRpcOneShot } from "./jsonrpc-oneshot";

export interface CodexModel {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

/** The subset of an app-server `model/list` row this module reads. */
interface RawModelRow {
  id: unknown;
  displayName?: unknown;
  description?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
}

const codexBin = () => agentBin("MIRAFOLD_CODEX_BIN", "codex");

/** `-c key=value` args for the spawn, values TOML-quoted. Nested tables
 *  flatten to dotted keys, the same form the codex CLI takes. */
function configArgs(config: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(config).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === "object" && v !== null
      ? configArgs(v as Record<string, unknown>, key)
      : ["-c", `${key}=${JSON.stringify(v)}`];
  });
}

/**
 * Ask a codex binary for its model catalog. Rejects on spawn failure,
 * protocol error, or timeout — the caller decides how to degrade (the
 * adapter surfaces an honest error, never a made-up list).
 *
 * `config` pins the question to the provider the ASKER means (2026-07-20).
 * Without it the binary answers through whatever `model_provider` the user's
 * config.toml names — so a session bound to first-party OpenAI was being
 * handed OpenRouter's catalog, and its "default" model, which a ChatGPT
 * account then refuses. The binary also keeps ONE global
 * `$CODEX_HOME/models_cache.json` across providers, so the wrong answer is
 * intermittent rather than reliable; pass the session's own binding here and
 * verify what comes back.
 */
export function listCodexModels(
  timeoutMs = 10_000,
  bin?: string,
  config: Record<string, unknown> = {},
): Promise<CodexModel[]> {
  return jsonRpcOneShot<CodexModel[]>({
    command: bin ?? codexBin(),
    args: ["app-server", ...configArgs(config)],
    timeoutMs,
    label: "codex app-server",
    start: (send) =>
      send({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "mirafold", title: "Mirafold", version: "0.0.1" } },
      }),
    onMessage: (raw, send, finish) => {
      const msg = raw as { id?: unknown; result?: { data?: unknown }; error?: { message?: string } };
      if (msg.error && (msg.id === 1 || msg.id === 2)) {
        finish(new Error(`codex app-server: ${msg.error.message ?? "request failed"}`));
      } else if (msg.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "model/list", params: { limit: 100 } });
      } else if (msg.id === 2) {
        const data = msg.result?.data;
        if (!Array.isArray(data)) {
          finish(new Error("codex app-server: malformed model/list response"));
          return;
        }
        finish(
          null,
          (data as RawModelRow[])
            .filter((m) => !m.hidden)
            .map((m) => ({
              id: String(m.id),
              displayName: String(m.displayName ?? m.id),
              description: String(m.description ?? ""),
              isDefault: Boolean(m.isDefault),
            })),
        );
      }
    },
  });
}
