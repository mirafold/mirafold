// The Gemini model catalog, asked of Gemini CLI itself (V.2's /model parity,
// Gemini half — the codex-model-list.ts analog).
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

import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

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
interface RawModelRow {
  modelId: unknown;
  name?: unknown;
  description?: unknown;
}

/** Resolved per call: MIRAFOLD_GEMINI_BIN overrides (the same operator knob +
 *  test seam the adapter uses), else the copy beside node, else PATH. */
const geminiBin = () => {
  if (process.env.MIRAFOLD_GEMINI_BIN) return process.env.MIRAFOLD_GEMINI_BIN;
  const beside = path.join(path.dirname(process.execPath), "gemini");
  return existsSync(beside) ? beside : "gemini";
};

/**
 * Ask the user's gemini binary for its model catalog. Rejects on spawn
 * failure, protocol error, or timeout — the caller decides how to degrade
 * (the adapter surfaces an honest error, never a made-up list).
 */
export function listGeminiModels(workspaceDir: string, timeoutMs = 15_000): Promise<GeminiModelCatalog> {
  return new Promise((resolve, reject) => {
    const child = spawn(geminiBin(), ["--acp"], {
      cwd: workspaceDir,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    const finish = (err: Error | null, catalog?: GeminiModelCatalog) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      // A child that ignores SIGTERM still dies; unref so the timer never
      // holds the daemon open (the codex-model-list hardening).
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      if (err) reject(err);
      else resolve(catalog!);
    };
    const timer = setTimeout(() => finish(new Error("gemini --acp: timed out")), timeoutMs);
    child.on("error", (err) => finish(err));
    child.on("exit", () => finish(new Error("gemini --acp: exited before answering")));

    const send = (obj: object) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: {
          id?: unknown;
          result?: { models?: { availableModels?: unknown; currentModelId?: unknown } };
          error?: { message?: string };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // stray non-JSON noise on stdout
        }
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
            models: (models.availableModels as RawModelRow[]).map((m) => ({
              id: String(m.modelId),
              displayName: String(m.name ?? m.modelId),
              description: String(m.description ?? ""),
            })),
            currentModelId: String(models.currentModelId ?? ""),
          });
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
    });
  });
}
