import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedLocally,
  allowedOverRelay,
  classifyOpenCodeProvider,
  type OpenCodeProviderEntry,
} from "./provider-policy";

// OC.3: the provider-keyed OpenCode matrix. Shapes are the 1.18.18 catalog
// facts captured with stored-credential fixtures (opencode.spike.md).

const entry = (over: Partial<OpenCodeProviderEntry>): OpenCodeProviderEntry => ({
  id: "p",
  source: "api",
  ...over,
});

test("a stored api key and an env key are api-key, allowed", () => {
  for (const source of ["api", "env"] as const) {
    const v = classifyOpenCodeProvider(entry({ id: "deepseek", source }));
    assert.deepEqual({ kind: v.kind, allowed: v.allowed }, { kind: "api-key", allowed: true });
  }
});

test("a user-config provider is BYO local, allowed", () => {
  const v = classifyOpenCodeProvider(entry({ id: "ollama", source: "config" }));
  assert.deepEqual({ kind: v.kind, allowed: v.allowed }, { kind: "local", allowed: true });
});

test("openai oauth is the one allowed subscription (the disclosed gray area)", () => {
  const v = classifyOpenCodeProvider(
    entry({ id: "openai", source: "custom", apiKeyOption: "opencode-oauth-dummy-key" }),
  );
  assert.deepEqual({ kind: v.kind, allowed: v.allowed }, { kind: "subscription", allowed: true });
});

test("every other oauth is refused with its reason — including ones never classified", () => {
  for (const id of ["github-copilot", "gitlab", "poe", "some-future-provider"]) {
    const v = classifyOpenCodeProvider(
      entry({ id, source: "custom", apiKeyOption: "opencode-oauth-dummy-key" }),
    );
    assert.equal(v.kind, "subscription");
    assert.equal(v.allowed, false, `${id} must fail closed`);
    assert.match(v.reason ?? "", /API key/);
  }
});

test("anthropic/google oauth are refused naming the written terms", () => {
  for (const id of ["anthropic", "google"]) {
    const v = classifyOpenCodeProvider(
      entry({ id, source: "custom", apiKeyOption: "opencode-oauth-dummy-key" }),
    );
    assert.equal(v.allowed, false);
    assert.match(v.reason ?? "", /written terms/);
  }
});

test("the built-in Zen gateway fails closed until its terms are read", () => {
  const v = classifyOpenCodeProvider(entry({ id: "opencode", source: "custom", apiKeyOption: "public" }));
  assert.equal(v.allowed, false);
  assert.match(v.reason ?? "", /Zen/);
});

test("an unrecognized custom shape is refused, never guessed", () => {
  const v = classifyOpenCodeProvider(entry({ id: "mystery", source: "custom" }));
  assert.deepEqual({ kind: v.kind, allowed: v.allowed }, { kind: "none", allowed: false });
  assert.match(v.reason ?? "", /doesn't recognize/);
});

test("agent-level opencode subscription stays fail-closed; relay gate unchanged", () => {
  // Without a provider resolution the agent-level answer is NO (the map's
  // fail-closed row) — the gray area only opens through the classified path.
  assert.equal(allowedLocally("opencode", "subscription"), false);
  assert.equal(allowedLocally("opencode", "api-key"), true);
  assert.equal(allowedOverRelay("subscription"), false);
  assert.equal(allowedOverRelay("api-key"), true);
});
