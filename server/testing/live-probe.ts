// Tier-4 availability probes: is the real thing on this machine?
//
// Tier 4 drives REAL agent binaries and REAL local models, so every test in it
// is conditional on the tool being installed. These probes answer that once,
// synchronously where possible, so a test file can pass node:test a `skip`
// reason instead of failing on a machine that simply doesn't have Ollama.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Is a codex binary on PATH (or named by MIRAFOLD_CODEX_BIN)? */
export function codexInstalled(): boolean {
  const bin = process.env.MIRAFOLD_CODEX_BIN ?? "codex";
  const r = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 20_000 });
  return r.status === 0;
}

/** Parse the effective per-model context override reported by Ollama's
 * `/api/show`. The base model's training context is not enough: without a
 * `num_ctx` parameter Ollama can still load it at 4K and truncate a Codex
 * prompt, which produced two false-green Tier-4 runs on 2026-08-11. */
export function ollamaConfiguredContext(parameters: unknown): number | undefined {
  if (typeof parameters !== "string") return undefined;
  const match = /^num_ctx\s+(\d+)\s*$/m.exec(parameters);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A running Ollama and the models it serves — [] when it isn't up. Tier 4's
 *  one free real model: local, unmetered, no credential of any kind. When a
 *  minimum context is requested, only explicit per-model `num_ctx` values
 *  count; guessing from a name or the base model's training metadata can let
 *  Ollama silently truncate the agent prompt. Results are sorted so Ollama's
 *  recency-dependent `/api/tags` order cannot change which model a test runs. */
export async function ollamaModels(minConfiguredContext = 0): Promise<string[]> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: { name?: unknown }[] };
    const names = (body.models ?? [])
      .map((m) => (typeof m.name === "string" ? m.name : ""))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (minConfiguredContext <= 0) return names;

    const eligible = await Promise.all(
      names.map(async (name) => {
        try {
          const show = await fetch("http://127.0.0.1:11434/api/show", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: name, verbose: false }),
            signal: AbortSignal.timeout(2_000),
          });
          if (!show.ok) return undefined;
          const detail = (await show.json()) as { parameters?: unknown };
          const context = ollamaConfiguredContext(detail.parameters);
          return context !== undefined && context >= minConfiguredContext ? name : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return eligible.filter((name): name is string => name !== undefined);
  } catch {
    return [];
  }
}

/**
 * Run `fn` against a throwaway CODEX_HOME populated with `configToml` (or left
 * bare), restoring the previous value and deleting the directory afterward.
 * Three jobs, all load-bearing for this tier — which is why they live here
 * once rather than in each test:
 *
 *  - **Hermetic**: the real binary writes state into its home — most
 *    importantly `models_cache.json`, the one-cache-for-all-providers file
 *    behind the 2026-07-20 model-binding bug. A test must never read or
 *    scribble on the developer's own `~/.codex`.
 *  - **Credential-free**: no `auth.json` is ever written here, so a first-party
 *    hosted call is impossible even if a test asks for one by mistake.
 *  - **Contained**: the restore keeps a temp home from leaking into every test
 *    that follows, and the cleanup keeps the tier from littering /tmp. Both
 *    run on the failure path too.
 */
export async function withCodexHome<T>(
  configToml: string | undefined,
  fn: (home: string) => Promise<T>,
): Promise<T> {
  const home = mkdtempSync(path.join(os.tmpdir(), "mirafold-live-codex-"));
  if (configToml !== undefined) writeFileSync(path.join(home, "config.toml"), configToml);
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
}

/** Every credential env var forced empty, for the duration of `fn`. Tier 4's
 *  hard bound: it may drive a real binary and a real LOCAL model, never a
 *  metered one. */
export async function withoutCredentials<T>(fn: () => Promise<T>): Promise<T> {
  const keys = [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
