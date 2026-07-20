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

/** A running Ollama and the models it serves — [] when it isn't up. Tier 4's
 *  one free real model: local, unmetered, no credential of any kind. */
export async function ollamaModels(): Promise<string[]> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: { name?: unknown }[] };
    return (body.models ?? []).map((m) => String(m.name)).filter(Boolean);
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
