import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConnectDevice,
  LicenseGate,
  PAY_URL,
  PairCardBody,
  RemoteAccessOff,
  entitlementGates,
  pairTitle,
} from "./ConnectDevice";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PAY_ANCHOR = new RegExp(`href="${escapeRe(PAY_URL)}" target="_blank" rel="noopener noreferrer"`);

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
  assert.match(html, PAY_ANCHOR);
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
  assert.match(gate, /<q class="pair-quote">unknown license key<\/q>/);
  assert.match(gate, PAY_ANCHOR);
  assert.doesNotMatch(gate, /pair-qr/);
  const outage = renderToStaticMarkup(createElement(LicenseGate, { view: { state: "unreachable", cached: false } }));
  assert.match(outage, /Couldn.{1,6}t reach the billing service/);
  assert.doesNotMatch(outage, /pair-cta/, "an outage is not a sales opportunity");
  const checking = renderToStaticMarkup(createElement(LicenseGate, { view: { state: "checking" } }));
  assert.match(checking, /checking your license key/);
});

// Review 2026-08-26: the tooltip is part of what the button claims at rest.
test("pairTitle sells only to the unentitled; an opt-out or a bad URL gets a plain off-line", () => {
  assert.match(pairTitle({ gated: false, relayOff: "unentitled" }), /Mirafold Pro/);
  assert.doesNotMatch(pairTitle({ gated: false, relayOff: "opt-out" }), /Mirafold Pro/);
  assert.doesNotMatch(pairTitle({ gated: false, relayOff: "malformed-url" }), /Mirafold Pro/);
  assert.match(pairTitle({ gated: true }), /license key/);
  assert.match(pairTitle({ href: "http://x/#code=y", gated: false }), /scan a QR/);
});

// Review 2026-08-26: a subscriber whose relay is off still has exactly one
// path to their subscription — the card the feature draws for them.
test("the manage link rides every resting arm when the daemon runs on a key", () => {
  const base = { billing: true, subRequest: () => "id", manage: false, setManage() {}, copied: false, onCopy() {} };
  const offButBilled = renderToStaticMarkup(createElement(PairCardBody, { ...base, relayOff: "opt-out" }));
  assert.match(offButBilled, /MIRAFOLD_RELAY_URL=off/);
  assert.match(offButBilled, /manage subscription/);
  const gate = renderToStaticMarkup(
    createElement(PairCardBody, { ...base, entitlement: { state: "invalid", reason: "lapsed" } }),
  );
  assert.match(gate, /<q class="pair-quote">lapsed<\/q>/);
  assert.match(gate, /manage subscription/);
  const qr = renderToStaticMarkup(createElement(PairCardBody, { ...base, href: "http://x/#code=y" }));
  assert.match(qr, /pair-qr/);
  assert.match(qr, /manage subscription/);
  // No key → no link, on either arm.
  const unbilled = renderToStaticMarkup(
    createElement(PairCardBody, { ...base, billing: false, subRequest: undefined, relayOff: "unentitled" }),
  );
  assert.doesNotMatch(unbilled, /manage subscription/);
});

// Review 2026-08-26: the backend's refusal line is quoted inside OUR sentence
// above a payment link — a direction control in it is rendered as a token,
// never obeyed (the Trojan-Source class the audit closed for engine strings).
test("a refusal reason's control characters are made visible, not obeyed", () => {
  const gate = renderToStaticMarkup(
    createElement(LicenseGate, { view: { state: "invalid", reason: "\u202Eactive — key renewed" } }),
  );
  assert.match(gate, /‹U\+202E›active/);
  assert.doesNotMatch(gate, /\u202E/);
});
