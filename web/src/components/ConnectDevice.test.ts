import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConnectDevice,
  DESKTOP_ACTIVATION_URL,
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
  assert.match(malformed, /not a usable Mirafold relay address/);
  assert.match(malformed, /no fragment/);
  assert.doesNotMatch(malformed, /pair-cta|mirafold\.com\/pay/);

  const invalidToken = renderToStaticMarkup(
    createElement(RemoteAccessOff, { reason: "invalid-entitlement-token" }),
  );
  assert.match(invalidToken, /MIRAFOLD_ENTITLEMENT_TOKEN/);
  assert.match(invalidToken, /request header/);
  assert.match(invalidToken, /remove that setting and relaunch/i);
  assert.doesNotMatch(invalidToken, /pair-cta|mirafold\.com\/pay|pair-qr/);
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
test("pairTitle sells only to the unentitled; configuration refusals get a plain off-line", () => {
  assert.match(pairTitle({ gated: false, relayOff: "unentitled" }), /Mirafold Pro/);
  assert.doesNotMatch(pairTitle({ gated: false, relayOff: "opt-out" }), /Mirafold Pro/);
  assert.doesNotMatch(pairTitle({ gated: false, relayOff: "malformed-url" }), /Mirafold Pro/);
  assert.doesNotMatch(pairTitle({ gated: false, relayOff: "invalid-entitlement-token" }), /Mirafold Pro/);
  assert.match(pairTitle({ gated: true }), /license key/);
  assert.match(pairTitle({ href: "http://x/#code=y", gated: false }), /scan a QR/);
});

// Review 2026-08-26: a subscriber whose relay is off still has exactly one
// path to their subscription — the card the feature draws for them.
test("the manage link rides every resting arm when the daemon runs on a key", () => {
  const base = { billing: true, subRequest: () => "id", manage: false, setManage() {}, copyState: "idle" as const, onCopy() {} };
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


// Captured from the existing pre-DA.2 render, before host support was added.
// The requirement is exact terminal/browser output, across every card arm.
const CARD_BASE = {
  billing: true, subRequest: () => "id", manage: false, setManage() {},
  copyState: "idle" as const, onCopy() {},
};
const PAIR_HREF = "http://phone.example/#code=abcdefghijklmnop";
const CARD_CASES: [string, Partial<ComponentProps<typeof PairCardBody>>, string][] = [
  ["unentitled", { relayOff: "unentitled", billing: false }, "1858caa8951f4eb4f38dcd68bb469b1557ff0078da6282027d5c05efac119ede"],
  ["opt-out", { relayOff: "opt-out" }, "42ced1c4d4488d1cb1cc6810da7a3cecd93a353284ce3538d89bc98bc9f6d1bf"],
  ["malformed URL", { relayOff: "malformed-url" }, "631dd99a4574a48aa71a82d23a56e35edc02835fd6dc15af481ad031433ff99e"],
  ["invalid token", { relayOff: "invalid-entitlement-token", billing: false }, "f934ff19827dd25c0224aee283db195ef9d57f60b28f4e636c227782de5a9e92"],
  ["checking", { entitlement: { state: "checking" } }, "1f96a7db617f5a9b9d19c837717eacb927bca7b43e5a3c10c13aa61649cb2a59"],
  ["invalid", { entitlement: { state: "invalid", reason: "subscription lapsed" } }, "f860db1356163bb874230e9cc6684fdc3c06c86b6641e808914d9348f1f0986b"],
  ["unreachable", { entitlement: { state: "unreachable", cached: false } }, "1eafc7b26c896c3fdc51fd4a064390417928fc960a41eab3b21196fc1e37b42d"],
  ["valid", { href: PAIR_HREF, entitlement: { state: "valid" } }, "2028ac70af1293e7fa33d73b035656a057aa9440ecd69d3fc494abe9cbccd2bc"],
  ["cached", { href: PAIR_HREF, entitlement: { state: "unreachable", cached: true } }, "088b95955b37068148c8507e591db78967bd18194c48d2cfaf8c410be164026c"],
  ["self-hosted", { href: PAIR_HREF }, "2028ac70af1293e7fa33d73b035656a057aa9440ecd69d3fc494abe9cbccd2bc"],
  ["copied", { href: PAIR_HREF, copyState: "copied" }, "79a28cfbfbc246ebd2acbf7ff2dc2163cef346098b6dcd7d03949ce29872a01e"],
  ["copy failed", { href: PAIR_HREF, copyState: "failed" }, "efd4c82258aaceca9598e9c74b9b3c4d64f4df8227095c15501266e3839d951d"],
  ["manage", { manage: true }, "b80c9c2df88425ecf11b7e341e51da598c9c0eb4394bf4b1a132edfb68071cd2"],
];

test("DA.2: every Pair card arm keeps the exact terminal markup; Desktop changes only activation offers", async (t) => {
  assert.equal(DESKTOP_ACTIVATION_URL, "https://mirafold.com/activate");
  for (const [name, props, beforeHash] of CARD_CASES) {
    for (const host of [undefined, "desktop"] as const) {
      await t.test(`${name}: ${host ?? "terminal"}`, () => {
        const html = renderToStaticMarkup(createElement(PairCardBody, { ...CARD_BASE, ...props, host }));
        if (host !== "desktop" || !["unentitled", "invalid"].includes(name)) {
          assert.equal(createHash("sha256").update(html).digest("hex"), beforeHash);
          assert.ok(!html.includes(DESKTOP_ACTIVATION_URL));
          return;
        }
        assert.match(html, /Activation finishes in your system browser and returns to Mirafold Desktop automatically\./);
        assert.doesNotMatch(html, /MIRAFOLD_LICENSE_KEY|relaunch|mirafold\.com\/pay|pair-qr/);
        const anchors = [...html.matchAll(/<a(?: class="[^"]*")? href="([^"]+)" target="_blank" rel="noopener noreferrer"/g)];
        assert.deepEqual(anchors.map((a) => a[1]), Array(name === "unentitled" ? 2 : 1).fill(DESKTOP_ACTIVATION_URL));
        if (name === "unentitled") assert.match(html, /Already have a license key\?/);
        else {
          assert.match(html, /<q class="pair-quote">subscription lapsed<\/q>/);
          assert.match(html, /renew or get Mirafold Pro/);
          assert.match(html, /manage subscription/);
        }
      });
    }
  }
});

test("DA.2: host and billing hints alone never add a Pair surface to a remote viewport", () => {
  for (const host of [undefined, "desktop"] as const) {
    assert.equal(renderToStaticMarkup(createElement(ConnectDevice, {
      host, billing: true, subRequest: () => "id", entitlement: { state: "invalid" },
    })), "");
  }
});
