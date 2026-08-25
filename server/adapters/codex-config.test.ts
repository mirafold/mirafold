import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexConfigProvider, parseCodexDefaultProvider, parseCodexProviders } from "./codex-config";

// The config.toml scan that lets a config-file BYO provider count as
// "configured" (retiring the dummy OPENAI_API_KEY=local recipe). The scan's
// failure mode must always be "no provider" — a config it can't read degrades
// to key/login detection, never a crash or a false positive.

test("no model_provider → undefined (a plain config is the first-party default)", () => {
  assert.equal(parseCodexDefaultProvider(""), undefined);
  assert.equal(parseCodexDefaultProvider('model = "gpt-5.3-codex"\n'), undefined);
});

test("model_provider = openai is the built-in default, not a BYO endpoint", () => {
  assert.equal(parseCodexDefaultProvider('model_provider = "openai"\n'), undefined);
});

test("a custom provider is read with its base_url from the matching table", () => {
  const toml = [
    'model = "qwen/qwen3-coder"',
    'model_provider = "openrouter"',
    "",
    "[model_providers.openrouter]",
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'wire_api = "responses"',
  ].join("\n");
  assert.deepEqual(parseCodexDefaultProvider(toml), {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  });
});

test("a provider declared without a base_url (e.g. the built-in oss) still counts", () => {
  assert.deepEqual(parseCodexDefaultProvider('model_provider = "oss"\n'), { provider: "oss" });
});

test("only the TOP-LEVEL model_provider counts — a profile's is never activated", () => {
  const toml = ["[profiles.local]", 'model_provider = "ollama"'].join("\n");
  assert.equal(parseCodexDefaultProvider(toml), undefined);
});

test("base_url is taken from the DEFAULT provider's table, not another provider's", () => {
  const toml = [
    'model_provider = "ollama"',
    "[model_providers.openrouter]",
    'base_url = "https://openrouter.ai/api/v1"',
    "[model_providers.ollama]",
    'base_url = "http://localhost:11434/v1"',
  ].join("\n");
  assert.deepEqual(parseCodexDefaultProvider(toml), {
    provider: "ollama",
    baseUrl: "http://localhost:11434/v1",
  });
});

test("table order doesn't matter — the provider table may precede the top-level key", () => {
  // TOML puts all top-level keys before any table, but a hand-edited file may
  // not; the scan collects every provider table and matches at the end.
  const toml = [
    "[model_providers.openrouter]",
    'base_url = "https://openrouter.ai/api/v1"',
  ].join("\n");
  // ...though a model_provider AFTER a table is inside that table, so the
  // faithful reading of this file is: no top-level default set.
  assert.equal(parseCodexDefaultProvider(toml + '\nmodel_provider = "openrouter"'), undefined);
});

test("single quotes, quoted table names, and trailing comments all read", () => {
  const toml = [
    "model_provider = 'openrouter' # one key, many open models",
    '[model_providers."openrouter"] # quoted table name',
    "base_url = 'https://openrouter.ai/api/v1' # comment",
  ].join("\n");
  assert.deepEqual(parseCodexDefaultProvider(toml), {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  });
});

// The full scan (2026-07-19): every declared [model_providers.<id>] entry —
// id, name, base_url, env_key — plus the default, so agent picker can offer one
// row per provider with honest key gating.

test("parseCodexProviders: every declared entry, file order, all read keys", () => {
  const toml = [
    'model_provider = "openrouter"',
    "[model_providers.openrouter]",
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'env_key = "OPENROUTER_API_KEY"',
    'wire_api = "responses"',
    "[model_providers.deepseek]",
    'base_url = "https://api.deepseek.com/v1"',
    'env_key = "DEEPSEEK_API_KEY"',
  ].join("\n");
  assert.deepEqual(parseCodexProviders(toml), {
    defaultProvider: "openrouter",
    entries: [
      {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        envKey: "OPENROUTER_API_KEY",
      },
      { id: "deepseek", baseUrl: "https://api.deepseek.com/v1", envKey: "DEEPSEEK_API_KEY" },
    ],
  });
});

test("parseCodexProviders: entries exist even when the default is openai (or unset)", () => {
  const toml = [
    "[model_providers.openrouter]",
    'env_key = "OPENROUTER_API_KEY"',
  ].join("\n");
  assert.deepEqual(parseCodexProviders(toml), {
    entries: [{ id: "openrouter", envKey: "OPENROUTER_API_KEY" }],
  });
  assert.deepEqual(parseCodexProviders('model_provider = "openai"\n' + toml), {
    defaultProvider: "openai",
    entries: [{ id: "openrouter", envKey: "OPENROUTER_API_KEY" }],
  });
});

test("parseCodexProviders: a bare table declares its provider; a profile table declares nothing", () => {
  const bare = parseCodexProviders("[model_providers.oss]\n");
  assert.deepEqual(bare.entries, [{ id: "oss" }]);
  const profile = parseCodexProviders('[profiles.x]\nmodel_provider = "ollama"\n');
  assert.deepEqual(profile, { entries: [] });
});

test("parseCodexDefaultProvider stays derived from the full scan (no drift)", () => {
  const toml = [
    'model_provider = "ollama"',
    "[model_providers.ollama]",
    'base_url = "http://localhost:11434/v1"',
    'env_key = "NOT_A_REAL_KEY"',
  ].join("\n");
  assert.deepEqual(parseCodexDefaultProvider(toml), {
    provider: "ollama",
    baseUrl: "http://localhost:11434/v1",
  });
});

test("codexConfigProvider reads CODEX_HOME/config.toml; a missing file is no provider", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "genui-codex-home-"));
  const saved = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = dir;
    assert.equal(codexConfigProvider(), undefined, "empty CODEX_HOME must scan as none");
    writeFileSync(
      path.join(dir, "config.toml"),
      'model_provider = "openrouter"\n[model_providers.openrouter]\nbase_url = "https://openrouter.ai/api/v1"\n',
    );
    assert.deepEqual(codexConfigProvider(), {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the config read is briefly cached — and a config APPEARING is never masked by a cached miss", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "genui-codex-home-"));
  const saved = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = dir;
    assert.equal(codexConfigProvider(), undefined);
    writeFileSync(
      path.join(dir, "config.toml"),
      'model_provider = "ollama"\n[model_providers.ollama]\nbase_url = "http://localhost:11434/v1"\n',
    );
    // A missing file is never cached, so the file appearing shows at once.
    assert.equal(codexConfigProvider()?.provider, "ollama");
    // Inside the TTL the cached text answers — this is the poll-smoothing
    // contract itself: remove the cache and this assertion fails.
    writeFileSync(path.join(dir, "config.toml"), 'model_provider = "other"\n');
    assert.equal(codexConfigProvider()?.provider, "ollama");
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
