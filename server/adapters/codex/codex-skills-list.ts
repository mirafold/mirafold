// Codex's `$` completion catalog, asked of the exact Codex binary through
// app-server `skills/list`. This is the same provider-owned metadata the TUI
// uses; no skill files are opened by Mirafold and disabled skills stay out.

import { agentBin } from "../types";
import { jsonRpcOneShot } from "../jsonrpc-oneshot";

export type CodexSkill = { name: string; description: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function listCodexSkills(
  workspaceDir: string,
  timeoutMs = 10_000,
  bin = agentBin("MIRAFOLD_CODEX_BIN", "codex"),
): Promise<CodexSkill[]> {
  return jsonRpcOneShot<CodexSkill[]>({
    command: bin,
    args: ["app-server"],
    cwd: workspaceDir,
    timeoutMs,
    label: "codex app-server",
    start: (send) =>
      send({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "mirafold", title: "Mirafold", version: "0.0.1" } },
      }),
    onMessage: (raw, send, finish) => {
      const msg = raw as {
        id?: unknown;
        result?: { data?: unknown };
        error?: { message?: string };
      };
      if (msg.error && (msg.id === 1 || msg.id === 2)) {
        finish(new Error(`codex app-server: ${msg.error.message ?? "request failed"}`));
      } else if (msg.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "skills/list", params: { cwds: [workspaceDir] } });
      } else if (msg.id === 2) {
        const data = msg.result?.data;
        if (!Array.isArray(data)) {
          finish(new Error("codex app-server: malformed skills/list response"));
          return;
        }
        const out: CodexSkill[] = [];
        for (const rawEntry of data) {
          if (!isObject(rawEntry)) continue;
          const entry = rawEntry as { cwd?: unknown; skills?: unknown };
          if (entry.cwd !== workspaceDir || !Array.isArray(entry.skills)) continue;
          for (const rawSkill of entry.skills) {
            if (!isObject(rawSkill)) continue;
            const skill = rawSkill as {
              name?: unknown;
              description?: unknown;
              enabled?: unknown;
            };
            if (skill.enabled === false || typeof skill.name !== "string" || !skill.name) continue;
            out.push({
              name: skill.name,
              description: typeof skill.description === "string" ? skill.description : "",
            });
          }
        }
        finish(null, out);
      }
    },
  });
}
