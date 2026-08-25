import { Codex, type CodexOptions } from "@openai/codex-sdk";
import { envWithout, installedAgentBin } from "./types";
import { MIRAFOLD_MCP, renderMcpCommand } from "./render-mcp-cmd";
import { listCodexModels, type CodexModel } from "./codex-model-list";
import { codexProviders, type CodexProviders } from "./codex-config";

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

/** Build the SDK runtime and model catalogs under one enforced provider
 * binding. Catalog and turn routing must share both the binary and provider;
 * splitting either can display a model the eventual turn cannot run. */
export function createCodexRuntimeBinding(options: {
  kind: CodexBackendKind | undefined;
  endpoint?: string;
  provider?: string;
  model?: string;
  makeCodex?: (options: CodexOptions) => Codex;
  listModels?: () => Promise<CodexModel[]>;
  listEngineModels?: () => Promise<CodexModel[]>;
}): {
  codex: Codex;
  engineBin?: string;
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

  // Drive the user's installed Codex when present so the terminal and SDK
  // share one engine version; machines without it retain the SDK fallback.
  // An explicit override is SPAWN intent and rides verbatim — even missing,
  // so the first turn ENOENTs honestly (the detection/spawn split of
  // types.ts); only the unset case consults installation lookup.
  const installedCodex =
    process.env.MIRAFOLD_CODEX_BIN || installedAgentBin("MIRAFOLD_CODEX_BIN", "codex");
  const codex = (options.makeCodex ?? ((codexOptions: CodexOptions) => new Codex(codexOptions)))({
    ...(installedCodex ? { codexPathOverride: installedCodex } : {}),
    ...(kind === "api-key" && process.env.OPENAI_API_KEY
      ? { apiKey: process.env.OPENAI_API_KEY }
      : {}),
    // Subscription must beat key precedence; local sessions must not receive
    // a key intended for another provider.
    ...(kind === "subscription" || kind === "local"
      ? { env: envWithout("OPENAI_API_KEY") }
      : {}),
    config: {
      mcp_servers: {
        [MIRAFOLD_MCP]: {
          command: RENDER_MCP.command,
          args: RENDER_MCP.args,
          // Mirafold's own render tools only emit validated UI messages; the
          // headless engine cannot prompt for their approval.
          default_tools_approval_mode: "approve",
        },
      },
      ...binding,
    },
  });

  // Ask the exact spawned binary for both catalogs under the same binding.
  // Injected test doubles may omit this private runtime path; model discovery
  // then performs its ordinary installed-binary lookup.
  const engineBin = (codex as unknown as { exec?: { executablePath?: string } }).exec
    ?.executablePath;
  const engineModels = () => listCodexModels(undefined, engineBin, binding);

  return {
    codex,
    engineBin,
    listModels: options.listModels ?? engineModels,
    listEngineModels: options.listEngineModels ?? engineModels,
    firstPartyOpenAI: binding["model_provider"] === "openai",
    endpointForRedaction,
    needsEngineDefaultModel: needsCodexEngineDefaultModel(kind, model, providerConfig),
  };
}
