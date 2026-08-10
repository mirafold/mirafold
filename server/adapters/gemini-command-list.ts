// Gemini's slash-command catalog, read from the ACP
// `available_commands_update` notification emitted immediately after
// session/new. The ACP registry is the command surface Gemini exposes to
// third-party clients, so this stays version-correct without scraping a TUI.

import { geminiBin } from "./gemini-model-list";
import { jsonRpcOneShot } from "./jsonrpc-oneshot";

export type GeminiCommand = { name: string; description: string; argumentHint?: string };

export function listGeminiCommands(
  workspaceDir: string,
  timeoutMs = 15_000,
): Promise<GeminiCommand[]> {
  return jsonRpcOneShot<GeminiCommand[]>({
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
        method?: unknown;
        params?: {
          update?: {
            sessionUpdate?: unknown;
            availableCommands?: unknown;
          };
        };
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
      } else if (
        msg.method === "session/update" &&
        msg.params?.update?.sessionUpdate === "available_commands_update"
      ) {
        const commands = msg.params.update.availableCommands;
        if (!Array.isArray(commands)) {
          finish(new Error("gemini --acp: malformed available_commands_update"));
          return;
        }
        finish(
          null,
          commands.flatMap((rawCommand) => {
            const command = rawCommand as {
              name?: unknown;
              description?: unknown;
              input?: { hint?: unknown };
            };
            if (typeof command.name !== "string" || !command.name) return [];
            return [{
              name: command.name,
              description: typeof command.description === "string" ? command.description : "",
              ...(typeof command.input?.hint === "string"
                ? { argumentHint: command.input.hint }
                : {}),
            }];
          }),
        );
      }
    },
  });
}
