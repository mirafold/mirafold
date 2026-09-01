import { agentBin, envWithout } from "./types";
import { MIRAFOLD_MCP, renderMcpCommand } from "./render-mcp-cmd";
import { configArgs, listCodexModels, type CodexModel } from "./codex-model-list";
import { codexProviders, type CodexProviders } from "./codex-config";
import type { AppServerSpawn } from "./codex-app-server";

export type CodexBackendKind = "api-key" | "subscription" | "local";

const RENDER_MCP = renderMcpCommand();

/** The provider half of an agent picker pick's enforcement. */
export function codexProviderBinding(
  kind: CodexBackendKind | undefined,
  endpoint: string | undefined,
  provider: string | undefined,
): Record<string, unknown> {
  if (kind === "local" && endpoint) {
    return {
      model_provider: "mirafold_local",
      model_providers: {
        mirafold_local: {
          name: "Mirafold-discovered local server",
          base_url: `${endpoint}/v1`,
          wire_api: "responses",
        },
      },
    };
  }
  if (kind === "local" && provider) return { model_provider: provider };
  if (kind === "api-key" || kind === "subscription") return { model_provider: "openai" };
  return {};
}

/** A forced first-party provider must not inherit a model chosen for a custom
 * config default. An explicit model always wins. */
export function needsCodexEngineDefaultModel(
  kind: CodexBackendKind | undefined,
  explicitModel: string | undefined,
  providers: CodexProviders,
): boolean {
  if ((kind !== "api-key" && kind !== "subscription") || explicitModel) return false;
  return (
    providers.defaultProvider !== undefined &&
    providers.defaultProvider !== "openai" &&
    providers.model !== undefined
  );
}

/** Select only the model the engine marks as default, preserving the
 * first-party guard against provider-qualified third-party model ids. */
export function codexEngineDefaultModel(
  models: readonly CodexModel[],
  firstPartyOpenAI: boolean,
): string {
  const model = models.find((candidate) => candidate.isDefault);
  if (!model) throw new Error("the engine's catalog marks no default model");
  if (firstPartyOpenAI && model.id.includes("/")) {
    throw new Error(`the catalog answered with \`${model.id}\`, which OpenAI's provider can't run`);
  }
  return model.id;
}

/** The per-process config every Codex session passes as `-c` overrides:
 *  Mirafold's required render MCP server, the provider the pick promised,
 *  and — for an API-key pick — the auth mode that makes app-server honor the
 *  env key.
 *  Everything else (sandbox, approvals, model defaults, the user's own MCP
 *  servers) is inherited from `~/.codex/config.toml` untouched. */
export function codexSessionConfig(
  kind: CodexBackendKind | undefined,
  binding: Record<string, unknown>,
): Record<string, unknown> {
  return {
    mcp_servers: {
      [MIRAFOLD_MCP]: {
        command: RENDER_MCP.command,
        args: RENDER_MCP.args,
        // A turn whose renderer never initialized cannot honor Mirafold's
        // structured-output contract. Codex's stable `required` setting makes
        // thread/start wait for this server and reject before model inference
        // if startup fails; the next prompt can retry with a fresh process.
        required: true,
        // Mirafold's own render tools only emit validated UI messages; the
        // headless engine cannot prompt for their approval.
        default_tools_approval_mode: "approve",
      },
    },
    ...binding,
    // CA.1 spike (2026-08-25): app-server prefers the auth.json ChatGPT login
    // over OPENAI_API_KEY unless the login method is forced — without this an
    // "api-key" session would silently run on the subscription, which the
    // relay's no-subscription bound cannot allow. Process-local: `-c` never
    // touches the user's config.toml or auth.json.
    ...(kind === "api-key" ? { forced_login_method: "api" } : {}),
  };
}

/** Build the app-server spawn and the model catalogs under one enforced
 * provider binding. Catalog and turn routing must share both the binary and
 * provider; splitting either can display a model the eventual turn cannot
 * run. */
export function createCodexRuntimeBinding(options: {
  kind: CodexBackendKind | undefined;
  endpoint?: string;
  provider?: string;
  model?: string;
  listModels?: () => Promise<CodexModel[]>;
  listEngineModels?: () => Promise<CodexModel[]>;
}): {
  spawn: AppServerSpawn;
  engineBin: string;
  listModels: () => Promise<CodexModel[]>;
  listEngineModels: () => Promise<CodexModel[]>;
  firstPartyOpenAI: boolean;
  endpointForRedaction?: string;
  needsEngineDefaultModel: boolean;
} {
  const { kind, endpoint, provider, model } = options;
  const providerConfig = codexProviders();
  const selectedProvider =
    provider ?? (kind === "local" && !endpoint ? providerConfig.defaultProvider : undefined);
  const endpointForRedaction =
    endpoint ?? providerConfig.entries.find((entry) => entry.id === selectedProvider)?.baseUrl;

  // Every explicit agent picker pick forces the provider its label promised.
  // A discovered local endpoint gets a per-session Responses provider;
  // config-declared local providers keep their own table and are selected by
  // id. A bare local pick and an unspecified backend inherit Codex's config.
  const binding = codexProviderBinding(kind, endpoint, provider);

  // The user's installed Codex (or the operator's explicit override) is the
  // engine — the same binary the terminal runs, so they share one version.
  // A missing binary spawns anyway and the first turn ENOENTs honestly (the
  // detection/spawn split of types.ts).
  const engineBin = agentBin("MIRAFOLD_CODEX_BIN", "codex");
  const spawn: AppServerSpawn = {
    command: engineBin,
    args: ["app-server", ...configArgs(codexSessionConfig(kind, binding))],
    // Subscription must beat key precedence; local sessions must not receive
    // a key intended for another provider. An api-key pick keeps the env key
    // (and forces the api login method above).
    env: kind === "subscription" || kind === "local" ? envWithout("OPENAI_API_KEY") : envWithout(),
  };

  // Ask the exact spawned binary for both catalogs under the same binding.
  const engineModels = () => listCodexModels(undefined, engineBin, binding);

  return {
    spawn,
    engineBin,
    listModels: options.listModels ?? engineModels,
    listEngineModels: options.listEngineModels ?? engineModels,
    firstPartyOpenAI: binding["model_provider"] === "openai",
    endpointForRedaction,
    needsEngineDefaultModel: needsCodexEngineDefaultModel(kind, model, providerConfig),
  };
}
