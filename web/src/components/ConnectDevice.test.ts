import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectDevice, LicenseGate, PAY_URL, RemoteAccessOff, entitlementGates } from "./ConnectDevice";

// The pair button is a fixture of every LOCAL viewport: with a relay it opens
// the QR; without one it opens the honest reason — and, when the reason is
// that nothing is configured, the one way to get Mirafold Pro. A remote
// viewport (neither field) still gets nothing: that phone is already paired.

test("the pair button renders with a relay, without one, and not for a remote viewport", () => {
  const withRelay = renderToStaticMarkup(
    createElement(ConnectDevice, { relay: { url: "http://127.0.0.1:1", code: "abcdefghijkl" } }),
  );
  assert.match(withRelay, /class="sb-pair"/);
  const unentitled = renderToStaticMarkup(createElement(ConnectDevice, { relayOff: "unentitled" }));
  assert.match(unentitled, /class="sb-pair"/);
  assert.match(unentitled, /Mirafold Pro/, "the tooltip names what the button offers");
  assert.equal(renderToStaticMarkup(createElement(ConnectDevice, {})), "");
});

test("no subscription: the card carries the pay link as a plain, opener-less anchor", () => {
  const html = renderToStaticMarkup(createElement(RemoteAccessOff, { reason: "unentitled" }));
  assert.equal(PAY_URL, "https://mirafold.com/pay");
  assert.match(html, new RegExp(`<a class="pair-cta" href="${PAY_URL}" target="_blank" rel="noopener noreferrer">`));
  assert.match(html, /Mirafold Pro/);
  assert.match(html, /MIRAFOLD_LICENSE_KEY/, "an existing subscriber is told how to connect the key");
  assert.doesNotMatch(html, /OpenAI permits|free/i);
});

test("relay off by the user's own setting: the card says which setting, and sells nothing", () => {
  const optOut = renderToStaticMarkup(createElement(RemoteAccessOff, { reason: "opt-out" }));
  assert.match(optOut, /MIRAFOLD_RELAY_URL=off/);
  assert.doesNotMatch(optOut, /pair-cta|mirafold\.com\/pay/);
  const malformed = renderToStaticMarkup(createElement(RemoteAccessOff, { reason: "malformed-url" }));
  assert.match(malformed, /not a valid/);
  assert.doesNotMatch(malformed, /pair-cta|mirafold\.com\/pay/);
});

// Phase PB.2: with a relay configured, the license-key read decides whether
// the QR is honest. Only `valid` (or an outage bridged by a cached token)
// carries; every other read replaces the QR with the truth and keeps the
// button, and the invalid one carries the offer.
test("entitlementGates: only a valid read, or an outage with a cached token, keeps the QR", () => {
  assert.equal(entitlementGates(undefined), false, "no read (self-host, token override) — as before");
  assert.equal(entitlementGates({ state: "valid" }), false);
  assert.equal(entitlementGates({ state: "unreachable", cached: true }), false);
  assert.equal(entitlementGates({ state: "unreachable", cached: false }), true);
  assert.equal(entitlementGates({ state: "invalid", reason: "unknown license key" }), true);
  assert.equal(entitlementGates({ state: "checking" }), true);
});

test("a refused key: no QR, the backend's reason quoted, the pay link, the button still there", () => {
  const relay = { url: "http://127.0.0.1:1", code: "abcdefghijkl" };
  const html = renderToStaticMarkup(
    createElement(ConnectDevice, { relay, entitlement: { state: "invalid", reason: "unknown license key" } }),
  );
  assert.match(html, /class="sb-pair"/);
  assert.match(html, /license key isn.{1,6}t carrying it/, "the tooltip tells the truth at rest");
  const gate = renderToStaticMarkup(
    createElement(LicenseGate, { view: { state: "invalid", reason: "unknown license key" } }),
  );
  assert.match(gate, /<q>unknown license key<\/q>/);
  assert.match(gate, new RegExp(`href="${PAY_URL}" target="_blank" rel="noopener noreferrer"`));
  assert.doesNotMatch(gate, /pair-qr/);
  const outage = renderToStaticMarkup(createElement(LicenseGate, { view: { state: "unreachable", cached: false } }));
  assert.match(outage, /Couldn.{1,6}t reach mirafold\.com/);
  assert.doesNotMatch(outage, /pair-cta/, "an outage is not a sales opportunity");
  const checking = renderToStaticMarkup(createElement(LicenseGate, { view: { state: "checking" } }));
  assert.match(checking, /checking your license key/);
});
