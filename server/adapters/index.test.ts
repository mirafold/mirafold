import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  availableAgents,
  backendOptions,
  isLoopbackEndpointUrl,
  mergeBackends,
  resolveBackendFor,
  resolveChosenBackend,
} from "./index";
import type { LocalServer } from "../local-models";
import { loadProjectEnv } from "../project-env";

// The per-provider policy, at the detection layer. This REVERSES the R.4b
// behavior (a Claude subscription login used to count as live): Anthropic's
// terms don't allow a subscription in a third-party app, so a login-only machine
// is now `blocked` (not live, with the API-key fix on the picker), while an API
// key or a local endpoint (ANTHROPIC_BASE_URL) is live. CLAUDE_CONFIG_DIR
// (Claude Code's own dir override) is the seam that makes this hermetic (R.4i).

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "DEFAULT_MODEL",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "CODEX_HOME",
  "CODEX_MODEL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

const claude = () => availableAgents().find((a) => a.agent === "claude-code")!;

function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "genui-creds-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("claude-code: no env keys and no credentials file → not live, not blocked (demo)", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty }, () => {
      const c = claude();
      assert.equal(c.live, false);
      assert.notEqual(c.blocked, true);
    });
  });
});

test("claude-code: a subscription login's credentials file alone → BLOCKED, not live (R.4i)", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, ".credentials.json"), "{}");
    withEnv({ CLAUDE_CONFIG_DIR: dir }, () => {
      const c = claude();
      assert.equal(c.live, false, "a Claude subscription must not run — Anthropic's terms");
      assert.equal(c.blocked, true, "and it's surfaced as blocked, not a bare demo");
    });
  });
});

test("credential probes are briefly cached — a second look inside the TTL serves the first answer", () => {
  withTempDir((dir) => {
    withEnv({ CLAUDE_CONFIG_DIR: dir }, () => {
      assert.equal(claude().live, false);
      writeFileSync(path.join(dir, ".credentials.json"), "{}");
      // Inside the TTL the cached probe stands (remove the cache and this
      // fails); the login shows on the first probe after it expires — the
      // window is a poll-smoother, short by design.
      assert.notEqual(claude().blocked, true);
    });
  });
});

test("claude-code: an Anthropic API key (or auth token) is live and not blocked", () => {
  withTempDir((empty) => {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      withEnv({ CLAUDE_CONFIG_DIR: empty, [key]: "x" }, () => {
        const c = claude();
        assert.equal(c.live, true, key);
        assert.notEqual(c.blocked, true, key);
      });
    }
  });
});

test("claude-code: a local/BYO endpoint (ANTHROPIC_BASE_URL) is live — even over a login", () => {
  withTempDir((dir) => {
    // A subscription login file is present, but the user pointed the SDK at a
    // local endpoint — that's `local` (open, anything goes), so it wins.
    writeFileSync(path.join(dir, ".credentials.json"), "{}");
    withEnv({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_BASE_URL: "http://localhost:11434" }, () => {
      const c = claude();
      assert.equal(c.live, true);
      assert.notEqual(c.blocked, true);
    });
  });
});

test("UX.8: a configured local endpoint gets a generic picker detail", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty, ANTHROPIC_BASE_URL: "http://localhost:11434" }, () => {
      const c = claude();
      assert.equal(c.live, true);
      assert.equal(c.detail, "local endpoint");
      assert.doesNotMatch(String(c.detail), /localhost|11434/);
    });
  });
});

test("a remote BYO endpoint (hosted open model) is labeled custom, not local", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty, ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" }, () => {
      const c = claude();
      assert.equal(c.live, true);
      assert.equal(c.detail, "custom endpoint");
      assert.doesNotMatch(String(c.detail), /deepseek/);
      assert.doesNotMatch(String(c.detail), /local endpoint/);
      // The second-step row carries the same opaque label.
      const row = backendOptions("claude-code").find((o) => o.kind === "local")!;
      assert.equal(row.detail, "custom endpoint");
    });
  });
});

test("R.4k: a malformed local endpoint falls back to a plain label, not a raw echo", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty, ANTHROPIC_BASE_URL: "not-a-valid-url" }, () => {
      const c = claude();
      assert.equal(c.live, true);
      assert.equal(c.detail, "local endpoint"); // no host, and no echoed raw value
    });
  });
});

test("R.4k: a configured model shows as the picker detail", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty, ANTHROPIC_API_KEY: "x", DEFAULT_MODEL: "claude-sonnet-5" }, () => {
      const c = claude();
      assert.equal(c.live, true);
      assert.equal(c.detail, "claude-sonnet-5");
    });
  });
});

test("R.4k: no detail on a non-live agent", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty }, () => {
      assert.equal(claude().detail, undefined);
    });
  });
});

// 2026-07-20: the row carries the KIND behind it, so a one-click create (single
// usable backend — Gemini is always that) can NAME what it runs on. Gemini with
// only an API key used to advertise `live` and nothing else: no detail (no model
// override) and no second step, so the credential was never stated anywhere.
test("a live agent advertises the kind behind it", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty, GEMINI_API_KEY: "x" }, () => {
      const gemini = availableAgents().find((a) => a.agent === "gemini-cli")!;
      assert.equal(gemini.live, true);
      assert.equal(gemini.kind, "api-key");
      assert.equal(gemini.detail, undefined); // no model override — the kind stands alone
    });
    withEnv({ CLAUDE_CONFIG_DIR: empty, ANTHROPIC_BASE_URL: "http://localhost:11434" }, () => {
      assert.equal(claude().kind, "local");
    });
    // Not live → no kind: there is no backing to name, only the fix to offer.
    withEnv({ CLAUDE_CONFIG_DIR: empty }, () => {
      assert.equal(claude().kind, undefined);
    });
  });
});

// N.1 — backendOptions(): every detected credential listed independently, no
// precedence collapse. The precedence in credentialKind() (BASE_URL > key >
// login; OPENAI_API_KEY > auth.json) must NOT hide the other options here —
// that silent collapse is exactly the confusion Phase N exists to end.

test("N.1 codex: API key AND a subscription login → TWO options, both usable", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "auth.json"), "{}");
    withEnv({ OPENAI_API_KEY: "x", CODEX_HOME: dir }, () => {
      const opts = backendOptions("codex");
      assert.deepEqual(
        opts.map((o) => o.kind),
        ["api-key", "subscription"],
      );
      // The subscription is the disclosed gray area (provider-policy): usable
      // locally, never blocked — its caveat is picker copy, not a policy gate.
      assert.ok(opts.every((o) => o.usable));
      assert.ok(opts.every((o) => o.blocked !== true));
    });
  });
});

test("N.1 claude-code: endpoint + key + login → THREE options; subscription blocked but VISIBLE", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, ".credentials.json"), "{}");
    withEnv(
      {
        CLAUDE_CONFIG_DIR: dir,
        ANTHROPIC_BASE_URL: "http://localhost:11434",
        ANTHROPIC_API_KEY: "x",
      },
      () => {
        const opts = backendOptions("claude-code");
        assert.deepEqual(
          opts.map((o) => o.kind),
          ["local", "api-key", "subscription"],
        );
        const [local, key, sub] = opts;
        assert.equal(local.usable, true);
        assert.equal(local.detail, "local endpoint");
        assert.equal(local.endpointUrl, "http://localhost:11434");
        assert.equal(key.usable, true);
        assert.equal(sub.usable, false, "an Anthropic subscription must not run — written terms");
        assert.equal(sub.blocked, true, "and it's listed blocked, never hidden");
      },
    );
  });
});

test("N.1: no credentials at all → an empty menu (the demo path is the agent row's job)", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty, CODEX_HOME: empty }, () => {
      assert.deepEqual(backendOptions("claude-code"), []);
      assert.deepEqual(backendOptions("codex"), []);
      assert.deepEqual(backendOptions("gemini-cli"), []);
    });
  });
});

test("N.1 gemini-cli: an API key is the one and only option (either env name)", () => {
  for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
    withEnv({ [key]: "x" }, () => {
      const opts = backendOptions("gemini-cli");
      assert.equal(opts.length, 1, key);
      assert.equal(opts[0].kind, "api-key");
      assert.equal(opts[0].usable, true);
    });
  }
});

// 2026-07-20: the model moved off `detail` onto its own `model` field — every
// row names the model it runs, in one place the picker renders uniformly.
test("N.1: configured model rides as the api-key option's model (per-agent env)", () => {
  withTempDir((empty) => {
    withEnv({ CODEX_HOME: empty, OPENAI_API_KEY: "x", CODEX_MODEL: "gpt-5.6-sol" }, () => {
      const [row] = backendOptions("codex");
      assert.equal(row.model, "gpt-5.6-sol");
      assert.equal(row.detail, undefined);
    });
  });
});

test("a declared provider row names the model codex would resolve for it", () => {
  withTempDir((home) => {
    writeFileSync(
      path.join(home, "config.toml"),
      [
        'model = "qwen/qwen3-coder"',
        'model_provider = "openrouter"',
        "[model_providers.openrouter]",
        'name = "OpenRouter"',
        'base_url = "https://openrouter.ai/api/v1"',
        'env_key = "OPENROUTER_API_KEY"',
      ].join("\n"),
    );
    withEnv({ CODEX_HOME: home, OPENROUTER_API_KEY: "x" }, () => {
      const row = backendOptions("codex").find((o) => o.provider === "openrouter");
      assert.equal(row?.usable, true);
      assert.equal(row?.detail, "OpenRouter");
      assert.equal(row?.model, "qwen/qwen3-coder");
    });
  });
});

// N.3 — mergeBackends(): dialect filtering + the env-endpoint dedupe. Servers
// are passed in (pure); the live cache binding is advertisedBackends'.

const OLLAMA: LocalServer = {
  endpoint: "http://127.0.0.1:11434",
  runtime: "ollama",
  dialects: ["anthropic", "openai"],
  models: ["llama3.2:3b"],
};
const LM_STUDIO: LocalServer = {
  endpoint: "http://127.0.0.1:1234",
  runtime: "lm-studio",
  dialects: ["openai"],
  models: ["qwen/qwen3-8b"],
};

test("N.3: dialect filter — ollama lists under BOTH claude-code and codex; openai-only under codex; gemini never", () => {
  withEnv({}, () => {
    const servers = [OLLAMA, LM_STUDIO];
    const forClaude = mergeBackends("claude-code", [], servers);
    assert.deepEqual(
      forClaude.map((b) => b.runtime),
      ["ollama"],
    );
    assert.deepEqual(forClaude[0].models, ["llama3.2:3b"]);
    assert.equal(forClaude[0].usable, true);
    assert.deepEqual(
      mergeBackends("codex", [], servers).map((b) => b.runtime),
      ["ollama", "lm-studio"],
    );
    assert.deepEqual(mergeBackends("gemini-cli", [], servers), []);
  });
});

test("N.3: credential options ride ahead of discovered servers in one menu", () => {
  withEnv({}, () => {
    const merged = mergeBackends("codex", backendOptionsFixture(), [LM_STUDIO]);
    assert.deepEqual(
      merged.map((b) => b.kind),
      ["api-key", "subscription", "local"],
    );
  });

  function backendOptionsFixture() {
    return [
      { kind: "api-key" as const, usable: true },
      { kind: "subscription" as const, usable: true },
    ];
  }
});

test("N.3: an env ANTHROPIC_BASE_URL naming a discovered server dedupes to the richer discovered row (localhost ≡ 127.0.0.1)", () => {
  withTempDir((empty) => {
    withEnv(
      { CLAUDE_CONFIG_DIR: empty, ANTHROPIC_BASE_URL: "http://localhost:11434" },
      () => {
        const merged = mergeBackends("claude-code", backendOptions("claude-code"), [OLLAMA]);
        // ONE local row — the discovered one, carrying the model catalog.
        assert.deepEqual(
          merged.map((b) => b.kind),
          ["local"],
        );
        assert.equal(merged[0].runtime, "ollama");
        assert.deepEqual(merged[0].models, ["llama3.2:3b"]);
      },
    );
  });
});

// A default model_provider in ~/.codex/config.toml is codex's BYO-endpoint
// analog of claude's ANTHROPIC_BASE_URL: detected as `local`, live on its own —
// which retires the dummy OPENAI_API_KEY=local recipe (docs/local-models.md).

const codexAgent = () => availableAgents().find((a) => a.agent === "codex")!;

const OPENROUTER_TOML =
  'model_provider = "openrouter"\n' +
  "[model_providers.openrouter]\n" +
  'base_url = "https://openrouter.ai/api/v1"\n' +
  'wire_api = "responses"\n';

test("codex: a config.toml default provider ALONE is live — no dummy key needed", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "config.toml"), OPENROUTER_TOML);
    withEnv({ CODEX_HOME: dir }, () => {
      const c = codexAgent();
      assert.equal(c.live, true);
      assert.equal(c.detail, "custom endpoint");
      assert.doesNotMatch(String(c.detail), /openrouter\.ai/);
      const opts = backendOptions("codex");
      assert.deepEqual(
        opts.map((o) => o.kind),
        ["local"],
      );
      assert.equal(opts[0].usable, true);
      assert.equal(opts[0].detail, "openrouter");
      assert.equal(
        resolveBackendFor("codex").provider,
        "openrouter",
        "the one-click path pins the configured provider identity",
      );
    });
  });
});

test("codex: config provider + API key + login → THREE options, nothing collapsed (N.1)", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "config.toml"), OPENROUTER_TOML);
    writeFileSync(path.join(dir, "auth.json"), "{}");
    withEnv({ CODEX_HOME: dir, OPENAI_API_KEY: "x" }, () => {
      assert.deepEqual(
        backendOptions("codex").map((o) => o.kind),
        ["local", "api-key", "subscription"],
      );
    });
  });
});

test("codex: a config provider naming a discovered server dedupes to the richer discovered row", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "config.toml"),
      'model_provider = "ollama"\n[model_providers.ollama]\nbase_url = "http://localhost:11434/v1"\n',
    );
    withEnv({ CODEX_HOME: dir }, () => {
      const merged = mergeBackends("codex", backendOptions("codex"), [OLLAMA]);
      assert.deepEqual(
        merged.map((b) => b.kind),
        ["local"],
      );
      assert.equal(merged[0].runtime, "ollama");
    });
  });
});

// Full optionality (2026-07-19): one row PER declared provider, key-gated,
// terminal-default first — and a pick that names its provider exactly, so the
// session can force what the label promised.

const TWO_PROVIDER_TOML =
  'model_provider = "openrouter"\n' +
  "[model_providers.openrouter]\n" +
  'name = "OpenRouter"\n' +
  'base_url = "https://openrouter.ai/api/v1"\n' +
  'env_key = "OPENROUTER_API_KEY"\n' +
  "[model_providers.deepseek]\n" +
  'base_url = "https://api.deepseek.com/v1"\n' +
  'env_key = "DEEPSEEK_API_KEY"\n';

test("codex: one row per declared provider — default first, first-party rows between", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "config.toml"), TWO_PROVIDER_TOML);
    writeFileSync(path.join(dir, "auth.json"), "{}");
    withEnv(
      { CODEX_HOME: dir, OPENAI_API_KEY: "x", OPENROUTER_API_KEY: "y", DEEPSEEK_API_KEY: "z" },
      () => {
        const opts = backendOptions("codex");
        assert.deepEqual(
          opts.map((o) => [o.kind, o.provider]),
          [
            ["local", "openrouter"], // the terminal's own default leads
            ["api-key", undefined],
            ["subscription", undefined],
            ["local", "deepseek"], // declared but not default — after first-party
          ],
        );
        assert.equal(opts[0].detail, "OpenRouter");
        assert.equal(opts[3].detail, "deepseek");
        assert.ok(opts.every((o) => o.usable));
      },
    );
  });
});

test("codex: a provider whose env_key variable is missing rows as unusable, fix named", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "config.toml"), TWO_PROVIDER_TOML);
    withEnv({ CODEX_HOME: dir, OPENROUTER_API_KEY: "y" }, () => {
      const opts = backendOptions("codex");
      const deepseek = opts.find((o) => o.provider === "deepseek")!;
      assert.equal(deepseek.usable, false);
      assert.match(String(deepseek.hint), /DEEPSEEK_API_KEY/);
      const openrouter = opts.find((o) => o.provider === "openrouter")!;
      assert.equal(openrouter.usable, true);
      assert.equal(openrouter.hint, undefined);
    });
  });
});

test("codex: provider rows ride the wire with provider+hint but never endpointUrl", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "config.toml"), TWO_PROVIDER_TOML);
    withEnv({ CODEX_HOME: dir, OPENROUTER_API_KEY: "y" }, () => {
      const merged = mergeBackends("codex", backendOptions("codex"), []);
      for (const row of merged) {
        assert.ok(!("endpointUrl" in row), "endpointUrl is server-side only");
      }
      assert.equal(merged[0].provider, "openrouter");
      assert.match(String(merged.find((r) => r.provider === "deepseek")!.hint), /DEEPSEEK/);
    });
  });
});

test("codex: a NON-default provider row also dedupes against the discovered server it names", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "config.toml"),
      "[model_providers.myollama]\n" + 'base_url = "http://localhost:11434/v1"\n',
    );
    withEnv({ CODEX_HOME: dir }, () => {
      const merged = mergeBackends("codex", backendOptions("codex"), [OLLAMA]);
      assert.deepEqual(
        merged.map((b) => [b.kind, b.provider, b.runtime]),
        [["local", undefined, "ollama"]], // the richer discovered row won
      );
    });
  });
});

test("codex: a provider pick resolves with its id; a missing key or unknown id refuses", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "config.toml"), TWO_PROVIDER_TOML);
    withEnv({ CODEX_HOME: dir, OPENROUTER_API_KEY: "y" }, () => {
      const ok = resolveChosenBackend("codex", { kind: "local", provider: "openrouter" }, []);
      assert.ok(!("error" in ok), JSON.stringify(ok));
      assert.equal(ok.kind, "local");
      assert.equal(ok.provider, "openrouter");
      assert.equal(ok.live, true);

      const noKey = resolveChosenBackend("codex", { kind: "local", provider: "deepseek" }, []);
      assert.ok("error" in noKey);
      assert.match(noKey.error, /DEEPSEEK_API_KEY/);

      const unknown = resolveChosenBackend("codex", { kind: "local", provider: "nope" }, []);
      assert.ok("error" in unknown);

      // The first-party id can't be smuggled through the provider path.
      const forged = resolveChosenBackend("codex", { kind: "local", provider: "openai" }, []);
      assert.ok("error" in forged);
    });
  });
});

test("codex: a config-provider pick resolves as `local` with NO endpoint — the adapter inherits the config", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "config.toml"), OPENROUTER_TOML);
    withEnv({ CODEX_HOME: dir }, () => {
      const r = resolveChosenBackend("codex", { kind: "local" }, []);
      assert.ok(!("error" in r), JSON.stringify(r));
      assert.equal(r.kind, "local");
      assert.equal(r.live, true);
      assert.equal(r.endpoint, undefined);
    });
  });
});

// N.5 — resolveChosenBackend(): the never-trust-the-client gate. Servers are
// injected (pure); the connection binds it to the live cache.

test("N.5 resolve: a forged or malformed choice refuses", () => {
  withEnv({}, () => {
    for (const bad of [null, 42, {}, { kind: "root" }, { kind: 7 }]) {
      const r = resolveChosenBackend("codex", bad, []);
      assert.ok("error" in r, JSON.stringify(bad));
    }
  });
});

test("N.5 resolve: a prohibited claude subscription REFUSES; the codex gray-area subscription resolves", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, ".credentials.json"), "{}");
    writeFileSync(path.join(dir, "auth.json"), "{}");
    withEnv({ CLAUDE_CONFIG_DIR: dir, CODEX_HOME: dir }, () => {
      const claude = resolveChosenBackend("claude-code", { kind: "subscription" }, []);
      assert.ok("error" in claude, "Anthropic's written prohibition must hold at create");
      const codex = resolveChosenBackend("codex", { kind: "subscription" }, []);
      assert.ok(!("error" in codex));
      assert.equal(codex.kind, "subscription");
      assert.equal(codex.live, true);
    });
  });
});

test("N.5 resolve: an absent credential refuses (nothing detected to back it)", () => {
  withTempDir((empty) => {
    withEnv({ CODEX_HOME: empty }, () => {
      const r = resolveChosenBackend("codex", { kind: "api-key" }, []);
      assert.ok("error" in r);
    });
  });
});

test("N.5 resolve: a discovered endpoint is validated against the live list — ok / gone / wrong dialect / model not served", () => {
  withEnv({}, () => {
    const ok = resolveChosenBackend(
      "codex",
      { kind: "local", endpoint: LM_STUDIO.endpoint, model: "qwen/qwen3-8b" },
      [LM_STUDIO],
    );
    assert.ok(!("error" in ok));
    assert.equal(ok.kind, "local");
    assert.equal(ok.endpoint, LM_STUDIO.endpoint);
    assert.equal(ok.model, "qwen/qwen3-8b");

    const gone = resolveChosenBackend(
      "codex",
      { kind: "local", endpoint: "http://127.0.0.1:9", model: "x" },
      [LM_STUDIO],
    );
    assert.ok("error" in gone, "a stopped server must refuse, not silently fall back");

    const wrongDialect = resolveChosenBackend(
      "claude-code",
      { kind: "local", endpoint: LM_STUDIO.endpoint },
      [LM_STUDIO],
    );
    assert.ok("error" in wrongDialect, "an openai-only server can't back claude-code");

    const staleModel = resolveChosenBackend(
      "codex",
      { kind: "local", endpoint: LM_STUDIO.endpoint, model: "not-served" },
      [LM_STUDIO],
    );
    assert.ok("error" in staleModel);
  });
});

test("UX.8: a configured endpoint is opaque on the wire and resolves to the exact server-side URL", () => {
  withTempDir((empty) => {
    const secretUrl = "https://alice:password@example.test/v1?sig=topsecret";
    withEnv({ CLAUDE_CONFIG_DIR: empty, ANTHROPIC_BASE_URL: secretUrl }, () => {
      const advertised = mergeBackends(
        "claude-code",
        backendOptions("claude-code"),
        [],
      )[0];
      assert.equal(advertised.endpoint, undefined);
      assert.match(advertised.backendId ?? "", /^[0-9a-f-]{36}$/);
      assert.doesNotMatch(JSON.stringify(advertised), /alice|password|example\.test|topsecret/);
      const r = resolveChosenBackend(
        "claude-code",
        { kind: "local", backendId: advertised.backendId },
        [],
      );
      assert.ok(!("error" in r));
      assert.equal(r.kind, "local");
      assert.equal(r.endpoint, secretUrl);
      assert.equal(r.endpointSource, "configured");
      assert.equal(r.endpointAuth, "none");
      assert.equal(
        resolveBackendFor("claude-code").endpoint,
        secretUrl,
        "the one-click path must pin the same endpoint without a choice frame",
      );
    });
  });
});

test("N.5 resolve: a forged endpoint cannot masquerade as the configured Claude URL", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty, ANTHROPIC_BASE_URL: "http://localhost:9999" }, () => {
      const r = resolveChosenBackend(
        "claude-code",
        { kind: "local", endpoint: "http://localhost:8888" },
        [],
      );
      assert.ok("error" in r);
    });
  });
});

test("N.3: an env endpoint the probe did NOT find stays its own row", () => {
  withTempDir((empty) => {
    withEnv(
      { CLAUDE_CONFIG_DIR: empty, ANTHROPIC_BASE_URL: "http://localhost:9999" },
      () => {
        const merged = mergeBackends("claude-code", backendOptions("claude-code"), [OLLAMA]);
        assert.deepEqual(
          merged.map((b) => b.kind),
          ["local", "local"],
        );
        assert.equal(merged[0].detail, "local endpoint"); // the opaque env row
        assert.equal(merged[0].endpoint, undefined);
        assert.ok(merged[0].backendId, "the env row has only an opaque browser identity");
        assert.equal(merged[0].onDevice, true);
        assert.equal(merged[1].runtime, "ollama"); // the discovered row
      },
    );
  });
});

test("UX.8: loopback classification is IP-exact, never a hostname prefix", () => {
  assert.equal(isLoopbackEndpointUrl("http://127.0.0.1:11434"), true);
  assert.equal(isLoopbackEndpointUrl("http://127.42.0.9"), true);
  assert.equal(isLoopbackEndpointUrl("http://[::1]:11434"), true);
  assert.equal(isLoopbackEndpointUrl("http://[::ffff:127.0.0.1]:11434"), true);
  assert.equal(isLoopbackEndpointUrl("https://127.attacker.test"), false);
  assert.equal(isLoopbackEndpointUrl("https://localhost.attacker.test"), false);

  const [lookalike] = mergeBackends(
    "claude-code",
    [{ kind: "local", usable: true, endpointUrl: "https://127.attacker.test" }],
    [],
  );
  assert.equal(lookalike.onDevice, undefined);
});

test("UX.8: a project-selected endpoint cannot inherit a parent-only Anthropic token", () => {
  withTempDir((dir) => {
    const config = path.join(dir, "project-config.txt");
    writeFileSync(config, "ANTHROPIC_BASE_URL=https://checkout.example/anthropic\n");
    withEnv({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_AUTH_TOKEN: "parent-secret" }, () => {
      loadProjectEnv(config);
      const backend = resolveBackendFor("claude-code");
      assert.equal(backend.endpoint, "https://checkout.example/anthropic");
      assert.equal(backend.endpointSource, "configured");
      assert.equal(
        backend.endpointAuth,
        "none",
        "checkout-selected destinations must not receive a parent-only token",
      );
    });
  });
});

test("BUGFIX: a checkpointed OpenCode backend restores — provider is annotation, not identity", () => {
  withTempDir((dataDir) => {
    // A usable row exists: the binary is "installed" (any real file via the
    // override) and no auth.json means the Zen gateway backs it.
    withEnv({ OPENCODE_BIN: process.execPath, XDG_DATA_HOME: dataDir }, () => {
      // The exact shapes the registry checkpoints after OC.4c publishes the
      // classified kind — all were rejected as "unknown backend choice",
      // stranding every dormant session (bughunt 2026-08-13, reproduced).
      const apiKey = resolveChosenBackend("opencode", {
        kind: "api-key",
        provider: "deepseek",
        model: "deepseek/deepseek-v4",
      });
      assert.ok(!("error" in apiKey));
      if (!("error" in apiKey)) {
        assert.equal(apiKey.live, true);
        assert.equal(apiKey.provider, "deepseek");
        assert.equal(apiKey.model, "deepseek/deepseek-v4");
      }
      const gateway = resolveChosenBackend("opencode", { kind: "gateway", provider: "opencode" });
      assert.ok(!("error" in gateway) && gateway.live, "Zen-classified sessions restore live");
      // The gray subscription restores live for openai ONLY (provider-keyed).
      const gray = resolveChosenBackend("opencode", { kind: "subscription", provider: "openai" });
      assert.ok(!("error" in gray) && gray.live);
      const copilot = resolveChosenBackend("opencode", {
        kind: "subscription",
        provider: "github-copilot",
      });
      assert.ok(!("error" in copilot) && !copilot.live, "unclassified oauth restores to the mock");
      // Round 2: kind "local" (a BYO config provider like Ollama) fell
      // through to the codex-only local branch and was unrecoverable.
      const byo = resolveChosenBackend("opencode", { kind: "local", provider: "ollama" });
      assert.ok(!("error" in byo) && byo.live && byo.provider === "ollama");
      // Real identity fields still refuse — only provider is annotation.
      assert.ok("error" in resolveChosenBackend("opencode", { kind: "api-key", backendId: "x" }));
    });
  });
});
