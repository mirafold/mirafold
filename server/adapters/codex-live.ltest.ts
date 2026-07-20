import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WireMsg } from "../protocol";
import { CodexSession } from "./codex";
import { listCodexModels } from "./codex-model-list";
import {
  codexInstalled,
  ollamaModels,
  tempCodexHome,
  withoutCredentials,
} from "../testing/live-probe";

// Tier 4 — the REAL codex binary, asked real questions.
//
// Why this tier exists: Tiers 1-3 all answer with fixtures. Tier 1 hand-feeds
// a synthetic event stream, and Tiers 2-3 force every credential empty so the
// daemon runs the MockSession. That is deliberate and stays that way — but it
// means nothing anywhere proves what the actual agent binary DOES: what its
// catalog contains, whose provider answers it, whether it accepts the flags we
// pass. The 2026-07-20 model-binding bug lived precisely in that gap: we asked
// the binary for "its default model", the user's config.toml answered through
// OpenRouter, and a ChatGPT-account session was handed `meituan/longcat-2.0`.
// Every mock in the suite was green.
//
// The bound this tier keeps: real binary, yes; real METERED model, never.
// Credentials are stripped (`withoutCredentials`) and CODEX_HOME is a throwaway
// with no auth.json, so a hosted call can't happen even by accident. The one
// real model here is Ollama's — local, free, and the same thing the product
// offers as a first-class backend.
//
// Everything skips cleanly when the tool isn't installed.

const HAVE_CODEX = codexInstalled();
const LOCAL_MODELS = await ollamaModels();

/** A config whose default provider is NOT first-party — the shape that made
 *  an unpinned catalog question answer with the wrong provider's models. */
const OPENROUTER_DEFAULT_TOML =
  'model = "qwen/qwen3-coder"\n' +
  'model_provider = "openrouter"\n\n' +
  "[model_providers.openrouter]\n" +
  'name = "OpenRouter"\n' +
  'base_url = "https://openrouter.ai/api/v1"\n' +
  'env_key = "OPENROUTER_API_KEY"\n' +
  'wire_api = "responses"\n';

test(
  "the real binary answers a PINNED catalog question with first-party models only",
  { skip: HAVE_CODEX ? false : "codex is not installed", timeout: 120_000 },
  async () => {
    const home = tempCodexHome(OPENROUTER_DEFAULT_TOML);
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const models = await withoutCredentials(() =>
        listCodexModels(60_000, undefined, { model_provider: "openai" }),
      );
      assert.ok(models.length > 0, "the pinned catalog must not come back empty");
      // The regression, stated as a contract: a `vendor/model` slug is a
      // third-party namespace. First-party OpenAI ids never carry a slash, so
      // one appearing here means the question was answered by the config's
      // provider instead of the one we pinned.
      const foreign = models.filter((m) => m.id.includes("/"));
      assert.deepEqual(foreign, [], `provider-foreign rows in a pinned catalog: ${foreign.map((m) => m.id)}`);
      // The adapter's engine-default path depends on exactly one marked row.
      assert.equal(models.filter((m) => m.isDefault).length, 1);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "the pin holds in the configuration that actually broke: OpenRouter default + a live key",
  {
    // The bug needed all three: a non-first-party default provider, a WORKING
    // key for it, and the binary's shared models_cache.json in the wrong
    // state. Only the first two can be arranged, so this asserts the one
    // direction that can never fail spuriously — pinned answers must be
    // first-party. A stub provider can't stand in: codex integrates OpenRouter
    // specifically and never fetches an arbitrary provider's base_url for
    // model/list (verified 2026-07-20).
    skip: !HAVE_CODEX
      ? "codex is not installed"
      : !process.env.OPENROUTER_API_KEY
        ? "no OPENROUTER_API_KEY — this test needs the real failing configuration"
        : false,
    timeout: 120_000,
  },
  async () => {
    const home = tempCodexHome(OPENROUTER_DEFAULT_TOML);
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      // Deliberately NOT credential-free: the key is the point. A catalog
      // fetch costs nothing — no inference happens on this path.
      const models = await listCodexModels(60_000, undefined, { model_provider: "openai" });
      const foreign = models.filter((m) => m.id.includes("/"));
      assert.deepEqual(
        foreign,
        [],
        `the pin leaked: OpenRouter's catalog answered a first-party question — ${foreign.map((m) => m.id)}`,
      );
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "a real turn on a real local model: text arrives, one turn_end, no error",
  {
    skip: !HAVE_CODEX
      ? "codex is not installed"
      : LOCAL_MODELS.length === 0
        ? "no Ollama server on 127.0.0.1:11434"
        : false,
    timeout: 300_000,
  },
  async () => {
    const home = tempCodexHome();
    const workspace = mkdtempSync(path.join(os.tmpdir(), "mirafold-live-ws-"));
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      await withoutCredentials(async () => {
        const msgs: WireMsg[] = [];
        const s = new CodexSession({
          workspaceDir: workspace,
          kind: "local",
          endpoint: "http://127.0.0.1:11434",
          model: LOCAL_MODELS[0],
        });
        const done = new Promise<void>((resolve) => {
          s.onMessage((m) => {
            msgs.push(m);
            if (m.type === "turn_end") resolve();
          });
        });
        s.pushPrompt("Reply with exactly: ok");
        await done;
        s.close();

        const errors = msgs.filter((m) => m.type === "error");
        assert.deepEqual(errors, [], `a local turn must not error: ${JSON.stringify(errors)}`);
        assert.equal(msgs.filter((m) => m.type === "turn_end").length, 1);
        const text = msgs
          .filter((m): m is Extract<WireMsg, { type: "text_delta" }> => m.type === "text_delta")
          .map((m) => m.text)
          .join("");
        assert.ok(text.trim().length > 0, "the model must actually say something");
        // Codex has no metadata for a local model's slug and says so. That is
        // an advisory the terminal shows as a warning — a NOTICE here, never
        // the red error line it used to render as (2026-07-20).
        for (const n of msgs.filter((m) => m.type === "notice")) {
          assert.ok(n.kind !== undefined, "a notice must be tagged so the UI can style it");
        }
      });
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
