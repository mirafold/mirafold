// The Gemini model catalog, asked of Gemini CLI itself (the
// codex-model-list.ts analog).
//
// Terminal Gemini's /model opens a picker dialog — TUI chrome the headless
// stream-json surface can't reach (headless bare /model is a fatal "dialog
// not supported" exit). But the LIST the dialog shows is computed by the
// binary itself, and its ACP surface answers it: `gemini --acp`, JSON-RPC
// initialize → session/new, whose response carries models.availableModels +
// currentModelId — the same access-gated rows (Auto + the manual models,
// previews only when the account has access) the terminal dialog builds.
// We spawn the user's own binary one-shot in the session's workspace (the
// gating reads workspace settings + env), read the answer, and kill it — so
// the list is exactly what THEIR terminal would show, never a hardcoded copy.

import { agentBin } from "./types";
import { jsonRpcOneShot } from "./jsonrpc-oneshot";

export interface GeminiModel {
  id: string;
  displayName: string;
  description: string;
}

export interface GeminiModelCatalog {
  models: GeminiModel[];
  currentModelId: string;
}

/** The subset of an ACP availableModels row this module reads. */
interface RawGeminiModelRow {
  modelId: unknown;
  name?: unknown;
  description?: unknown;
}

/** Also the adapter's spawn resolver — one definition for both spawns. */
export const geminiBin = () => agentBin("MIRAFOLD_GEMINI_BIN", "gemini");

/**
 * Ask the user's gemini binary for its model catalog. Rejects on spawn
 * failure, protocol error, or timeout — the caller decides how to degrade
 * (the adapter surfaces an honest error, never a made-up list).
 */
export function listGeminiModels(workspaceDir: string, timeoutMs = 15_000): Promise<GeminiModelCatalog> {
  return jsonRpcOneShot<GeminiModelCatalog>({
    command: geminiBin(),
    args: ["--acp"],
    cwd: workspaceDir,
    timeoutMs,
    label: "gemini --acp",
    start: (send) =>
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        },
      }),
    onMessage: (raw, send, finish) => {
      const msg = raw as {
        id?: unknown;
        result?: { models?: { availableModels?: unknown; currentModelId?: unknown } };
        error?: { message?: string };
      };
      if (msg.error && (msg.id === 1 || msg.id === 2)) {
        finish(new Error(`gemini --acp: ${msg.error.message ?? "request failed"}`));
      } else if (msg.id === 1) {
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd: workspaceDir, mcpServers: [] },
        });
      } else if (msg.id === 2) {
        const models = msg.result?.models;
        if (!models || !Array.isArray(models.availableModels)) {
          finish(new Error("gemini --acp: malformed session/new response"));
          return;
        }
        finish(null, {
          models: models.availableModels
            .filter(
              (row): row is RawGeminiModelRow =>
                typeof row === "object" &&
                row !== null &&
                typeof (row as { modelId?: unknown }).modelId === "string" &&
                Boolean((row as { modelId: string }).modelId),
            )
            .map((m) => ({
              id: m.modelId as string,
              displayName: String(m.name ?? m.modelId),
              description: String(m.description ?? ""),
            })),
          currentModelId: String(models.currentModelId ?? ""),
        });
      }
    },
  });
}
