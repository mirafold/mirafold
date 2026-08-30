import { test } from "node:test";
import assert from "node:assert/strict";
import {
  carriesCredentialInClear,
  DEFAULT_APP_URL,
  DEFAULT_RELAY_URL,
  resolveRelayPlan,
} from "./relay-url";

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
    origin: "wss://relay.mirafold.sh",
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
    origin: "ws://127.0.0.1:9100",
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

// 2026-08-11 audit: a bearer credential (entitlement token / license key)
// riding a plaintext non-loopback URL is stealable on the path. TLS and
// loopback are exempt; a plaintext remote host warns.
test("audit 2026-08-11: cleartext-credential detection covers scheme and host", () => {
  // Exempt: TLS anywhere.
  assert.equal(carriesCredentialInClear("wss://relay.example"), false);
  assert.equal(carriesCredentialInClear("https://mirafold.com/api/entitlement"), false);
  // Exempt: plaintext but loopback (dev stub / same-box self-host).
  assert.equal(carriesCredentialInClear("ws://127.0.0.1:9100"), false);
  assert.equal(carriesCredentialInClear("ws://localhost:9100"), false);
  assert.equal(carriesCredentialInClear("http://127.0.0.1:8000/api"), false);
  assert.equal(carriesCredentialInClear("ws://[::1]:9100"), false);
  // Exposed: plaintext to a real host.
  assert.equal(carriesCredentialInClear("ws://relay.example"), true);
  assert.equal(carriesCredentialInClear("http://entitlement.example/api"), true);
  assert.equal(carriesCredentialInClear("ws://10.0.0.5:9100"), true);
  // A host that only LOOKS loopback is still remote.
  assert.equal(carriesCredentialInClear("ws://127.0.0.1.evil.test"), true);
  // Malformed → false (other code refuses it).
  assert.equal(carriesCredentialInClear("not a url"), false);
});

// A malformed or non-ws explicit URL is REFUSED here, as its own off-reason:
// index.ts warns once, remote access stays off, and the CSP admits nothing.
test("a malformed explicit URL resolves to off/malformed-url, never a dial", () => {
  for (const raw of ["https://not-a-ws-url", "garbage"]) {
    assert.deepEqual(resolveRelayPlan({ MIRAFOLD_RELAY_URL: raw }), {
      kind: "off",
      reason: "malformed-url",
      raw,
    });
  }
  const plan = resolveRelayPlan({ MIRAFOLD_RELAY_URL: "wss://relay.example/path" });
  assert.equal(plan.kind === "dial" && plan.origin, "wss://relay.example");
});

// Review 2026-08-26: the pair card presents on the entitlement exchange only
// where that exchange IS the relay's gate.
test("presentsOnEntitlement: the hosted default, or an operator's own backend — never a plain self-host", async () => {
  const { presentsOnEntitlement, resolveRelayPlan } = await import("./relay-url");
  const hosted = resolveRelayPlan({ MIRAFOLD_LICENSE_KEY: "mf_x" });
  assert.equal(presentsOnEntitlement(hosted, {}), true);
  const selfHost = resolveRelayPlan({ MIRAFOLD_RELAY_URL: "ws://my-relay.lan:9100", MIRAFOLD_LICENSE_KEY: "mf_x" });
  assert.equal(presentsOnEntitlement(selfHost, {}), false, "an ungated relay carries a refused key fine");
  assert.equal(presentsOnEntitlement(selfHost, { MIRAFOLD_ENTITLEMENT_URL: "http://127.0.0.1:1/api/entitlement" }), true);
  assert.equal(presentsOnEntitlement(resolveRelayPlan({}), {}), false);
});

test("review 2026-08-29: the hosted relay spelled out by hand keeps the hosted semantics", async () => {
  const { presentsOnEntitlement } = await import("./relay-url");
  // A user who copies the default into .env must get exactly what leaving it
  // unset gets: the hosted app origin (the relay host serves no app) and the
  // license gate — never an "explicit" self-host plan with a twin-fallback QR.
  const byHand = resolveRelayPlan({ MIRAFOLD_RELAY_URL: DEFAULT_RELAY_URL, MIRAFOLD_LICENSE_KEY: "mf_x" });
  assert.deepEqual(byHand, resolveRelayPlan({ MIRAFOLD_LICENSE_KEY: "mf_x" }));
  assert.equal(byHand.kind === "dial" && byHand.appUrl, DEFAULT_APP_URL);
  assert.equal(presentsOnEntitlement(byHand, {}), true);
  // Same origin, any spelling: a trailing slash still means hosted — and the
  // dial uses the canonical URL, because the client appends /daemon verbatim.
  const withSlash = resolveRelayPlan({ MIRAFOLD_RELAY_URL: `${DEFAULT_RELAY_URL}/`, MIRAFOLD_LICENSE_KEY: "mf_x" });
  assert.deepEqual(withSlash, byHand);
  // And without an entitlement it stands down like the bake does — dialing
  // the gated relay unentitled is a guaranteed refusal either way.
  assert.deepEqual(resolveRelayPlan({ MIRAFOLD_RELAY_URL: DEFAULT_RELAY_URL }), { kind: "off", reason: "unentitled-default" });
  // An explicit app origin still rides it.
  const appToo = resolveRelayPlan({ MIRAFOLD_RELAY_URL: DEFAULT_RELAY_URL, MIRAFOLD_LICENSE_KEY: "mf_x", MIRAFOLD_APP_URL: "https://app.example" });
  assert.equal(appToo.kind === "dial" && appToo.appUrl, "https://app.example");
});
