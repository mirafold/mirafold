import { test } from "node:test";
import assert from "node:assert/strict";
import { cookieToken, isAllowedOrigin, safeRedirectPath, startupUrl, verifyToken } from "./auth";

test("startupUrl percent-encodes a token instead of creating new URL syntax", () => {
  const token = "x&calc|whoami (proof)";
  const url = startupUrl(3000, token);
  assert.equal(new URL(url).searchParams.get("token"), token);
  assert.equal(url.includes(token), false);
  assert.match(url, /token=x%26calc%7Cwhoami/);
  assert.equal(startupUrl(3000, ""), "http://127.0.0.1:3000/");
});

test("cookieToken extracts the mirafold_token value", () => {
  assert.equal(cookieToken("mirafold_token=abc"), "abc");
  assert.equal(cookieToken("foo=1; mirafold_token=abc; bar=2"), "abc");
  assert.equal(cookieToken("mirafold_token=a%20b"), "a b"); // URL-decoded
});

test("cookieToken returns undefined when absent/malformed", () => {
  assert.equal(cookieToken(undefined), undefined);
  assert.equal(cookieToken(""), undefined);
  assert.equal(cookieToken("foo=1"), undefined);
  assert.equal(cookieToken("no-equals-sign"), undefined);
  assert.equal(cookieToken("mirafold_tokenX=abc"), undefined); // must be an exact name match
  assert.equal(cookieToken("mirafold_token=%"), undefined, "a malformed URI escape is invalid, not fatal");
  assert.equal(
    cookieToken("mirafold_token=%; mirafold_token=healed"),
    "healed",
    "a later valid duplicate can recover from a malformed stale value",
  );
});

const authOn = { port: 3000, authEnabled: true };
const authOff = { port: 3000, authEnabled: false };

test("isAllowedOrigin: our own origin and no-Origin pass, foreign fails", () => {
  assert.equal(isAllowedOrigin(undefined, authOn), true); // non-browser client
  assert.equal(isAllowedOrigin("http://localhost:3000", authOn), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:3000", authOn), true);
  assert.equal(isAllowedOrigin("http://[::1]:3000", authOn), true);
  assert.equal(isAllowedOrigin("http://evil.example.com", authOn), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1.evil.com", authOn), false);
  assert.equal(isAllowedOrigin("not a url", authOn), false);
});

test("isAllowedOrigin: with auth ON another loopback PORT is refused (2026-07-27 audit)", () => {
  // The hole this closes: cookies are scoped by host but not by port, and an
  // IP literal is its own registrable domain — so SameSite=Strict does not
  // fire between ports. A page on any other local port was same-site with us,
  // and the browser would hand it our cookie.
  assert.equal(isAllowedOrigin("http://127.0.0.1:5173", authOn), false);
  assert.equal(isAllowedOrigin("http://localhost:8080", authOn), false);
  assert.equal(isAllowedOrigin("http://[::1]:4321", authOn), false);
  // Scheme counts too — cookies aren't scheme-isolated, and we only serve http.
  assert.equal(isAllowedOrigin("https://127.0.0.1:3000", authOn), false);
  // A port we never bound can't be matched into an open gate.
  assert.equal(isAllowedOrigin("http://127.0.0.1:3000", { port: -1, authEnabled: true }), false);
});

test("isAllowedOrigin: with auth OFF the loopback family passes (Vite dev proxy)", () => {
  // No cookie exists to steal, and index.ts warns loudly that any local page
  // can drive the agent in this posture — `dev:server` sets MIRAFOLD_TOKEN="".
  assert.equal(isAllowedOrigin("http://127.0.0.1:5173", authOff), true);
  assert.equal(isAllowedOrigin("http://localhost:5173", authOff), true);
  assert.equal(isAllowedOrigin("http://evil.example.com", authOff), false);
});

test("verifyToken accepts a matching cookie or ?token= query", () => {
  const T = "secret";
  assert.equal(verifyToken({ headers: { cookie: "mirafold_token=secret" } }, T, true), true);
  assert.equal(verifyToken({ headers: {}, url: "/ws?token=secret" }, T, true), true);
  assert.equal(
    verifyToken({ headers: { cookie: "mirafold_token=%" }, url: "/ws?token=secret" }, T, true),
    true,
    "a malformed cookie does not block valid query-token recovery",
  );
});

test("verifyToken rejects a wrong or missing token when enabled", () => {
  const T = "secret";
  assert.equal(verifyToken({ headers: { cookie: "mirafold_token=wrong" } }, T, true), false);
  assert.equal(verifyToken({ headers: {}, url: "/ws?token=wrong" }, T, true), false);
  assert.equal(verifyToken({ headers: {}, url: "/ws" }, T, true), false);
  assert.equal(verifyToken({ headers: {} }, T, true), false);
});

test("verifyToken always passes when auth is disabled", () => {
  assert.equal(verifyToken({ headers: {} }, "", false), true);
  assert.equal(verifyToken({ headers: {}, url: "/ws" }, "", false), true);
});

test("safeRedirectPath: ordinary paths pass, protocol-relative escapes collapse to /", () => {
  assert.equal(safeRedirectPath("/"), "/");
  assert.equal(safeRedirectPath("/s/abc-123"), "/s/abc-123");
  assert.equal(safeRedirectPath("//evil.example.com"), "/");
  assert.equal(safeRedirectPath("/\\evil.example.com"), "/"); // browsers treat /\ like //
});
