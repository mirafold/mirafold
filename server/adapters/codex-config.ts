import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";

/**
 * Reads the ONE fact Mirafold needs from the user's own Codex config
 * (`~/.codex/config.toml`, honoring `CODEX_HOME` like the CLI): whether a
 * default `model_provider` other than OpenAI is configured, and where it
 * points. That's how a config-file BYO provider (Ollama made the default, or
 * a hosted open-model API like OpenRouter — docs/local-models.md) becomes
 * visible to onboarding, so it can count as configured on its own — the old
 * recipe needed a dummy `OPENAI_API_KEY=local` purely to flip that signal.
 *
 * Deliberately NOT a TOML parser (zero deps, same as the rest of the server):
 * a line scan for the two keys involved — the top-level `model_provider`, and
 * that provider's `base_url` inside its `[model_providers.<name>]` table.
 * Anything it can't read scans as "no provider", which degrades to the
 * pre-existing behavior (key/login detection) — never a crash, never a
 * false positive.
 */

export type CodexConfigProvider = {
  provider: string;
  baseUrl?: string;
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

/** The pure scan (the testable half): the default non-OpenAI provider named
 *  by this config text, with its `base_url` when declared. `model_provider`
 *  counts only at the TOP level — inside a `[profiles.x]` table it's a
 *  profile Mirafold never activates (we pass no `--profile`). */
export function parseCodexDefaultProvider(toml: string): CodexConfigProvider | undefined {
  let table: string | undefined;
  let provider: string | undefined;
  const baseUrls = new Map<string, string>();
  for (const line of toml.split("\n")) {
    const t = line.match(TABLE_RE);
    if (t) {
      table = tableName(t[1]);
      continue;
    }
    const kv = line.match(KV_RE);
    if (!kv) continue;
    const [, key, dq, sq] = kv;
    const value = dq ?? sq;
    if (key === "model_provider" && table === undefined) provider = value;
    else if (key === "base_url" && table?.startsWith("model_providers."))
      baseUrls.set(table.slice("model_providers.".length), value);
  }
  // `openai` is the built-in first-party default — that's the api-key world,
  // not a BYO endpoint.
  if (!provider || provider === "openai") return undefined;
  const baseUrl = baseUrls.get(provider);
  return { provider, ...(baseUrl ? { baseUrl } : {}) };
}

/** The I/O half: the user's actual Codex config, `CODEX_HOME` honored (it's
 *  also the itest harness's seam for forcing a clean machine). Missing or
 *  unreadable file → no provider, same as the CLI's own default. */
export function codexConfigProvider(): CodexConfigProvider | undefined {
  const dir = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  let text: string;
  try {
    text = readFileSync(path.join(dir, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
  return parseCodexDefaultProvider(text);
}
