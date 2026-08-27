import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectDevice, PAY_URL, RemoteAccessOff } from "./ConnectDevice";

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
