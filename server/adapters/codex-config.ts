import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";

/**
 * Reads the facts Mirafold needs from the user's own Codex config
 * (`~/.codex/config.toml`, honoring `CODEX_HOME` like the CLI): which
 * `model_provider` is the default, and every `[model_providers.<id>]` entry
 * the user has declared — id, display name, where it points (`base_url`),
 * and which environment variable authenticates it (`env_key`). That's how
 * config-file BYO providers (Ollama made the default, or hosted open-model
 * APIs like OpenRouter — docs/local-models.md) become visible to onboarding:
 * each is its own backend row, present only because the user themselves
 * declared it, usable only when its named key is actually present.
 *
 * Deliberately NOT a TOML parser (zero deps, same as the rest of the server):
 * a line scan for the handful of keys involved. Anything it can't read scans
 * as "not declared", which degrades to the pre-existing behavior (key/login
 * detection) — never a crash, never a false positive.
 */

export type CodexConfigProvider = {
  provider: string;
  baseUrl?: string;
};

/** One `[model_providers.<id>]` declaration, as far as Mirafold reads it. */
export type CodexProviderEntry = {
  id: string;
  name?: string;
  baseUrl?: string;
  envKey?: string;
};

export type CodexProviders = {
  /** The top-level `model_provider` — what terminal codex runs by default.
   *  Absent means codex's own built-in default (the first-party `openai`). */
  defaultProvider?: string;
  /** The top-level `model` — chosen by the user FOR the default provider
   *  above; foreign to any other provider a session might force. */
  model?: string;
  /** Every declared `[model_providers.<id>]` table, in file order. */
  entries: CodexProviderEntry[];
};

// `key = "value"` (or single quotes), optionally followed by a comment.
const KV_RE = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/;
// `[table.name]` — arrays-of-tables (`[[...]]`) intentionally won't match the
// names we compare against, which is correct: neither key lives in one.
const TABLE_RE = /^\s*\[\s*(.+?)\s*\]\s*(?:#.*)?$/;

/** Normalize a TOML table name: dot-split, strip optional quotes per part —
 *  so `[model_providers."openrouter"]` equals `[model_providers.openrouter]`. */
function tableName(raw: string): string {
  return raw
    .split(".")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .join(".");
}

/** The pure scan (the testable half): the default provider plus every
 *  declared `[model_providers.<id>]` entry. `model_provider` counts only at
 *  the TOP level — inside a `[profiles.x]` table it's a profile Mirafold
 *  never activates (we pass no `--profile`). */
export function parseCodexProviders(toml: string): CodexProviders {
  let table: string | undefined;
  let defaultProvider: string | undefined;
  let model: string | undefined;
  const entries = new Map<string, CodexProviderEntry>();
  const entryFor = (id: string): CodexProviderEntry => {
    const existing = entries.get(id);
    if (existing) return existing;
    const fresh: CodexProviderEntry = { id };
    entries.set(id, fresh);
    return fresh;
  };
  for (const line of toml.split("\n")) {
    const t = line.match(TABLE_RE);
    if (t) {
      table = tableName(t[1]);
      // Naming the table declares the provider even before (or without) any
      // keys inside it — file order is display order downstream.
      if (table.startsWith("model_providers.")) entryFor(table.slice("model_providers.".length));
      continue;
    }
    const kv = line.match(KV_RE);
    if (!kv) continue;
    const [, key, dq, sq] = kv;
    const value = dq ?? sq;
    if (table === undefined) {
      if (key === "model_provider") defaultProvider = value;
      else if (key === "model") model = value;
    } else if (table.startsWith("model_providers.")) {
      const entry = entryFor(table.slice("model_providers.".length));
      if (key === "name") entry.name = value;
      else if (key === "base_url") entry.baseUrl = value;
      else if (key === "env_key") entry.envKey = value;
    }
  }
  return {
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(model ? { model } : {}),
    entries: [...entries.values()],
  };
}

/** The default non-OpenAI provider with its `base_url` — the single-answer
 *  view credentialKind uses ("did the user point codex elsewhere?"). Derived
 *  from the full scan so the two can't drift. `openai` is the built-in
 *  first-party default — that's the api-key world, not a BYO endpoint. */
export function parseCodexDefaultProvider(toml: string): CodexConfigProvider | undefined {
  const { defaultProvider, entries } = parseCodexProviders(toml);
  if (!defaultProvider || defaultProvider === "openai") return undefined;
  const baseUrl = entries.find((e) => e.id === defaultProvider)?.baseUrl;
  return { provider: defaultProvider, ...(baseUrl ? { baseUrl } : {}) };
}

// Short-lived read cache: onboarding's open-picker poll re-derives the whole
// backend menu every few seconds, and one pass reads this file several times.
// One read serves a pass; an edited config still shows within seconds — the
// TTL must stay short, this is a poll-smoother, never a boot-time snapshot.
// A missing file is never cached, so a config appearing shows immediately.
const CONFIG_TTL_MS = Number(process.env.CODEX_CONFIG_TTL_MS ?? 2_000);
let configCache: { file: string; at: number; text: string } | undefined;

function readConfig(): string | undefined {
  const file = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
  if (configCache && configCache.file === file && Date.now() - configCache.at < CONFIG_TTL_MS) {
    return configCache.text;
  }
  try {
    const text = readFileSync(file, "utf8");
    configCache = { file, at: Date.now(), text };
    return text;
  } catch {
    configCache = undefined;
    return undefined;
  }
}

/** The I/O half: the user's actual Codex config, `CODEX_HOME` honored (it's
 *  also the itest harness's seam for forcing a clean machine). Missing or
 *  unreadable file → no provider, same as the CLI's own default. */
export function codexConfigProvider(): CodexConfigProvider | undefined {
  const text = readConfig();
  return text === undefined ? undefined : parseCodexDefaultProvider(text);
}

/** All declared providers + the default, from the user's actual config. */
export function codexProviders(): CodexProviders {
  const text = readConfig();
  return text === undefined ? { entries: [] } : parseCodexProviders(text);
}
