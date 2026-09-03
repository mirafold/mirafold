import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import type { WireMsg } from "../../protocol";
import { CodexSession } from "./codex";
import { listCodexModels } from "./codex-model-list";
import { codexInstalled, ollamaModels, withCodexHome, withoutCredentials } from "../../testing/live-probe";

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

// Every Codex session now asks folder-trust before its first turn (CA.3), and
// each test workspace here is a fresh mkdtemp — untrusted. Point the trust
// record at a THROWAWAY file (never the real state dir) so a live yes can't
// pollute Kyle's trusted-workspaces, and auto-approve the ask so these
// transport tests exercise a real turn. `autoApproveTrust(session)` wires the
// yes; the gate itself is proven in the Tier-2 unit tests.
let trustFile: string;
before(() => {
  trustFile = path.join(mkdtempSync(path.join(os.tmpdir(), "mirafold-live-trust-")), "trusted.json");
  writeFileSync(trustFile, "[]");
  process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = trustFile;
});
after(() => {
  delete process.env.MIRAFOLD_WORKSPACE_TRUST_FILE;
});
const autoApproveTrust = (s: CodexSession) =>
  s.onMessage((m) => {
    if (m.type === "permission_request") s.resolvePermission(m.id, true);
  });
// A 4K Ollama runner reserves roughly half its window for output and silently
// truncated the ~7.7K Codex prompt to 2,050 tokens in two false-green runs.
// Tier 4 accepts only a model whose `/api/show` proves a 32K override.
const MIN_LOCAL_CONTEXT = 32_768;
const LOCAL_MODELS = await ollamaModels(MIN_LOCAL_CONTEXT);

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

/** Ask the OS for a currently free loopback port, then close it. The returned
 * endpoint is genuinely unavailable when the real Codex probe starts; no
 * hardcoded port can make that guarantee on an arbitrary developer machine. */
async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "the loopback fixture must have an address");
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  return address.port;
}

test(
  "the real binary answers a PINNED catalog question with first-party models only",
  { skip: HAVE_CODEX ? false : "codex is not installed", timeout: 120_000 },
  () =>
    withCodexHome(OPENROUTER_DEFAULT_TOML, async () => {
      const models = await withoutCredentials(() =>
        listCodexModels(60_000, undefined, { model_provider: "openai" }),
      );
      assert.ok(models.length > 0, "the pinned catalog must not come back empty");
      // The regression, stated as a contract: a `vendor/model` slug is a
      // third-party namespace. First-party OpenAI ids never carry a slash, so
      // one appearing here means the question was answered by the config's
      // provider instead of the one we pinned.
      const foreign = models.filter((m) => m.id.includes("/"));
      assert.deepEqual(
        foreign,
        [],
        `provider-foreign rows in a pinned catalog: ${foreign.map((m) => m.id)}`,
      );
      // The adapter's engine-default path depends on exactly one marked row.
      assert.equal(models.filter((m) => m.isDefault).length, 1);
    }),
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
  () =>
    withCodexHome(OPENROUTER_DEFAULT_TOML, async () => {
      // Deliberately NOT credential-free: the key is the point. A catalog
      // fetch costs nothing — no inference happens on this path.
      const models = await listCodexModels(60_000, undefined, { model_provider: "openai" });
      const foreign = models.filter((m) => m.id.includes("/"));
      assert.deepEqual(
        foreign,
        [],
        `the pin leaked: OpenRouter's catalog answered a first-party question — ${foreign.map((m) => m.id)}`,
      );
    }),
);

test(
  "a real Codex turn against an unavailable local engine: the reconnection is visible, and the watchdog ends it promptly",
  { skip: HAVE_CODEX ? false : "codex is not installed", timeout: 40_000 },
  (t) =>
    withCodexHome(undefined, async () => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), "mirafold-live-unavailable-"));
      try {
        await withoutCredentials(async () => {
          const port = await closedLoopbackPort();
          const msgs: WireMsg[] = [];
          const s = new CodexSession({
            workspaceDir: workspace,
            kind: "local",
            endpoint: `http://127.0.0.1:${port}`,
            model: "unavailable-local-model",
            // On a connection failure, app-server does NOT fail the turn — it
            // emits `Reconnecting…` (willRetry) roughly every 8 s and retries
            // forever, exactly as the Codex TUI does. For a discovered-local
            // session the adapter's watchdog is what ends it; 12 s leaves room
            // for at least one reconnection notice to reach the transcript
            // first (measured 2026-08-25).
            localTurnTimeoutMs: 12_000,
          });
          autoApproveTrust(s);
          let abortTurn: (() => void) | undefined;
          const done = new Promise<void>((resolve, reject) => {
            abortTurn = () => {
              s.close();
              reject(t.signal.reason ?? new Error("unavailable-engine test aborted"));
            };
            t.signal.addEventListener("abort", abortTurn, { once: true });
            s.onMessage((message) => {
              msgs.push(message);
              if (message.type === "turn_end") resolve();
            });
          });
          try {
            const startedAt = Date.now();
            s.pushPrompt("Reply with exactly: ok");
            await done;
            const elapsedMs = Date.now() - startedAt;
            // The engine's reconnection attempts are shown as retry notices in
            // Codex's own words — badged to it, not spoken as Mirafold's.
            const retries = msgs.filter(
              (m): m is Extract<WireMsg, { type: "notice" }> => m.type === "notice" && m.kind === "retry",
            );
            assert.ok(retries.length >= 1, "the reconnection must be visible as at least one retry notice");
            assert.match(retries[0].text, /reconnect|network/i);
            assert.equal(retries[0].source, "codex");
            // The watchdog ends the turn once, with one actionable error.
            const errors = msgs.filter((message) => message.type === "error");
            assert.equal(errors.length, 1);
            assert.match(errors[0].message, /did not finish within 12 seconds/);
            assert.ok(elapsedMs < 25_000, `the watchdog took ${elapsedMs} ms to fire`);
            assert.equal(msgs.filter((message) => message.type === "turn_end").length, 1);
          } finally {
            if (abortTurn) t.signal.removeEventListener("abort", abortTurn);
            s.close();
          }
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }),
);

test(
  "a real local turn with reasoning disabled: text arrives, one turn_end, no error",
  {
    skip: !HAVE_CODEX
      ? "codex is not installed"
      : LOCAL_MODELS.length === 0
        ? `no Ollama model with an explicit num_ctx >= ${MIN_LOCAL_CONTEXT}`
        : false,
    // The adapter itself ends an unfinished discovered-local turn at 480 s.
    // The extra 30 s lets that actionable product error reach the assertion
    // instead of letting node:test erase it with its own timeout first.
    timeout: 510_000,
  },
  (t) =>
    withCodexHome(undefined, async () => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), "mirafold-live-ws-"));
      try {
        await withoutCredentials(async () => {
          const msgs: WireMsg[] = [];
          const s = new CodexSession({
            workspaceDir: workspace,
            kind: "local",
            endpoint: "http://127.0.0.1:11434",
            model: LOCAL_MODELS[0],
          });
          autoApproveTrust(s);
          let abortTurn: (() => void) | undefined;
          const aborted = new Promise<never>((_, reject) => {
            abortTurn = () => {
              s.close();
              reject(t.signal.reason ?? new Error("local turn test aborted"));
            };
            t.signal.addEventListener("abort", abortTurn, { once: true });
          });
          const turnWaiters: Array<() => void> = [];
          s.onMessage((m) => {
            msgs.push(m);
            if (m.type === "turn_end") turnWaiters.shift()?.();
          });
          const nextTurnEnd = () => new Promise<void>((resolve) => turnWaiters.push(resolve));
          try {
            // Qwen's default Responses behavior can spend minutes generating
            // hidden reasoning after prompt prefill. `/effort none` is the
            // shipped, explicit local control verified by this test; the
            // adapter still inherits the user's default until they choose it.
            const effortDone = nextTurnEnd();
            s.pushPrompt("/effort none");
            await Promise.race([effortDone, aborted]);
            assert.ok(
              msgs.some(
                (m) => m.type === "text_delta" && m.text.includes("Reasoning effort set to none"),
              ),
              "the real local session must accept the reasoning-off control",
            );
            assert.deepEqual(msgs.filter((m) => m.type === "error"), []);
            msgs.length = 0;

            const done = nextTurnEnd();
            s.pushPrompt("Reply with exactly: ok");
            await Promise.race([done, aborted]);

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
          } finally {
            if (abortTurn) t.signal.removeEventListener("abort", abortTurn);
            s.close();
          }
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }),
);


test("the vendored protocol digest matches the installed Codex (TS.7)", { skip: !HAVE_CODEX && "codex not installed" }, async () => {
  type Digest = { items: Record<string, unknown>; notifications: string[]; fields: Record<string, unknown> };
  // A plain .mjs script with no declaration file; the specifier is widened so
  // TypeScript does not try to type it.
  const { generateDigest } = (await import("../../scripts/codex-protocol-digest.mjs" as string)) as {
    generateDigest: () => Digest;
  };
  const { readFileSync } = await import("node:fs");
  const live = generateDigest();
  const vendored = JSON.parse(readFileSync(new URL("./codex-protocol.digest.json", import.meta.url), "utf8"));
  const diff = (a: Record<string, unknown>, b: Record<string, unknown>, label: string) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${label}.${k}`);
  };
  const drift = [
    ...diff(live.items, vendored.items, "items"),
    ...diff(live.fields, vendored.fields, "fields"),
    ...(JSON.stringify(live.notifications) === JSON.stringify(vendored.notifications) ? [] : ["notifications"]),
  ];
  assert.deepEqual(
    drift,
    [],
    `Codex's protocol moved under the adapter — re-run \`node scripts/codex-protocol-digest.mjs --write\` and reclassify: ${drift.join(", ")}`,
  );
});
