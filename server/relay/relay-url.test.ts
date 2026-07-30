import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_APP_URL, DEFAULT_RELAY_URL, resolveRelayPlan } from "./relay-url";

// The bake's load-bearing rule: the default engages ONLY when a dial could
// succeed (an entitlement is configured). An unentitled daemon must never
// dial the gated relay by default — that's a 4007 refusal on a widening
// retry forever (log spam locally, churn on the relay).
test("unset URL + no entitlement → off, as the actionable-boot-line case", () => {
  assert.deepEqual(resolveRelayPlan({}), { kind: "off", reason: "unentitled-default" });
});

test("unset URL + license key → the baked default, app origin included", () => {
  assert.deepEqual(resolveRelayPlan({ MIRAFOLD_LICENSE_KEY: "mf_abc" }), {
    kind: "dial",
    url: DEFAULT_RELAY_URL,
    source: "default",
    appUrl: DEFAULT_APP_URL,
  });
});

test("a hand-issued token counts as entitled too", () => {
  const plan = resolveRelayPlan({ MIRAFOLD_ENTITLEMENT_TOKEN: "tok" });
  assert.equal(plan.kind, "dial");
  assert.equal(plan.kind === "dial" && plan.url, DEFAULT_RELAY_URL);
});

test("whitespace-only entitlement is NOT entitled", () => {
  assert.equal(resolveRelayPlan({ MIRAFOLD_LICENSE_KEY: "   " }).kind, "off");
});

// The self-host / dev-stub path: an explicit URL keeps pre-bake behavior
// verbatim — dialed entitled or not (an ungated relay accepts tokenless
// dials), and NO app-origin default (the HTTP-twin fallback serves dev).
test("explicit URL dials with no entitlement and no default app origin", () => {
  assert.deepEqual(resolveRelayPlan({ MIRAFOLD_RELAY_URL: "ws://127.0.0.1:9100" }), {
    kind: "dial",
    url: "ws://127.0.0.1:9100",
    source: "explicit",
    appUrl: undefined,
  });
});

test("explicit MIRAFOLD_APP_URL rides any dial, trailing slash trimmed", () => {
  const plan = resolveRelayPlan({
    MIRAFOLD_RELAY_URL: "wss://relay.example",
    MIRAFOLD_APP_URL: "https://app.example//",
  });
  assert.equal(plan.kind === "dial" && plan.appUrl, "https://app.example");
  const defaulted = resolveRelayPlan({
    MIRAFOLD_LICENSE_KEY: "mf_abc",
    MIRAFOLD_APP_URL: "https://app.example",
  });
  assert.equal(defaulted.kind === "dial" && defaulted.appUrl, "https://app.example");
});

test("the documented opt-outs turn remote access off quietly", () => {
  for (const v of ["off", "OFF", "none", "disabled", "false", "0"]) {
    assert.deepEqual(
      resolveRelayPlan({ MIRAFOLD_RELAY_URL: v, MIRAFOLD_LICENSE_KEY: "mf_abc" }),
      { kind: "off", reason: "opt-out" },
      `opt-out value ${JSON.stringify(v)}`,
    );
  }
});

test("empty / whitespace URL means unset, not opt-out", () => {
  assert.deepEqual(resolveRelayPlan({ MIRAFOLD_RELAY_URL: "  " }), {
    kind: "off",
    reason: "unentitled-default",
  });
  const entitled = resolveRelayPlan({ MIRAFOLD_RELAY_URL: "", MIRAFOLD_LICENSE_KEY: "mf_abc" });
  assert.equal(entitled.kind === "dial" && entitled.url, DEFAULT_RELAY_URL);
});

// A malformed explicit URL still reaches index.ts's REFUSED path (relayOrigin
// null → no dial, loud warning) — this module doesn't validate, it resolves.
test("a malformed explicit URL is passed through for the REFUSED warning, not swallowed", () => {
  const plan = resolveRelayPlan({ MIRAFOLD_RELAY_URL: "https://not-a-ws-url" });
  assert.equal(plan.kind, "dial");
  assert.equal(plan.kind === "dial" && plan.url, "https://not-a-ws-url");
});
