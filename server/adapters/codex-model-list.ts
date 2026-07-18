// The Codex model catalog, asked of Codex itself (V.2's /model parity).
//
// Terminal Codex's /model picker is interactive TUI chrome the headless SDK
// can't reach, but the LIST it shows comes from the binary's own
// `app-server` JSON-RPC surface (`model/list` — the same catalog, same
// order, same descriptions; verified live against the terminal picker
// side-by-side). We spawn the user's own `codex` binary one-shot, do the
// initialize handshake, ask, and kill it — so the answer is exactly what
// THEIR terminal would show, never a hardcoded or version-skewed copy.
//
// Note the deliberate binary choice: the PATH `codex` (the user's install),
// not the SDK's bundled one — the catalog is filtered per client version,
// and parity means the user's version's answer.

import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

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

/** Resolved per call: MIRAFOLD_CODEX_BIN overrides (operator knob + the test
 *  seam, like MIRAFOLD_GEMINI_BIN), else the copy beside node (nvm global
 *  installs land there), else PATH. */
const codexBin = () => {
  if (process.env.MIRAFOLD_CODEX_BIN) return process.env.MIRAFOLD_CODEX_BIN;
  const beside = path.join(path.dirname(process.execPath), "codex");
  return existsSync(beside) ? beside : "codex";
};

/**
 * Ask the user's codex binary for its model catalog. Rejects on spawn
 * failure, protocol error, or timeout — the caller decides how to degrade
 * (the adapter surfaces an honest error, never a made-up list).
 */
export function listCodexModels(timeoutMs = 10_000): Promise<CodexModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin(), ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let settled = false;
    const finish = (err: Error | null, models?: CodexModel[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      // A child that ignores SIGTERM still dies; unref so the timer never
      // holds the daemon open (2026-07-18 audit).
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      if (err) reject(err);
      else resolve(models ?? []);
    };
    const timer = setTimeout(() => finish(new Error("codex app-server: timed out")), timeoutMs);
    child.on("error", (err) => finish(err));
    child.on("exit", () => finish(new Error("codex app-server: exited before answering")));

    const send = (obj: object) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: unknown; result?: { data?: unknown }; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // stray non-JSON noise on stdout
        }
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
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "mirafold", title: "Mirafold", version: "0.0.1" } },
    });
  });
}
