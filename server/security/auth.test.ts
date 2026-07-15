import { test } from "node:test";
import assert from "node:assert/strict";
import { cookieToken, isLoopbackOrigin, verifyToken } from "./auth";

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
});

test("isLoopbackOrigin: loopback and no-Origin pass, foreign fails", () => {
  assert.equal(isLoopbackOrigin(undefined), true); // non-browser client
  assert.equal(isLoopbackOrigin("http://localhost:3000"), true);
  assert.equal(isLoopbackOrigin("http://127.0.0.1:3000"), true);
  assert.equal(isLoopbackOrigin("http://[::1]:3000"), true);
  assert.equal(isLoopbackOrigin("http://evil.example.com"), false);
  assert.equal(isLoopbackOrigin("http://127.0.0.1.evil.com"), false);
  assert.equal(isLoopbackOrigin("not a url"), false);
});

test("verifyToken accepts a matching cookie or ?token= query", () => {
  const T = "secret";
  assert.equal(verifyToken({ headers: { cookie: "mirafold_token=secret" } }, T, true), true);
  assert.equal(verifyToken({ headers: {}, url: "/ws?token=secret" }, T, true), true);
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
