import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createEntitlementTokenSource } from "./entitlement";

// The daemon's token source (R.5). These tests stub global fetch — the failure
// posture under test is "never throw, never block, degrade to no-token".

const futureExp = () => Math.floor(Date.now() / 1000) + 48 * 3600;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("token override wins outright: no exchange ever runs", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("must not be called");
  });
  try {
    const src = createEntitlementTokenSource({
      MIRAFOLD_ENTITLEMENT_TOKEN: "hand.token",
      MIRAFOLD_LICENSE_KEY: "mf_alsoset", // override still wins (warn, not error)
    });
    assert.equal(src.mode, "token-override");
    assert.equal(await src.get(), "hand.token");
    assert.equal(await src.get({ refresh: true }), "hand.token");
    assert.equal(fetchMock.mock.callCount(), 0);
    src.stop();
  } finally {
    fetchMock.mock.restore();
  }
});

test("nothing configured: mode none, get() is undefined, fetch untouched", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("must not be called");
  });
  try {
    const src = createEntitlementTokenSource({});
    assert.equal(src.mode, "none");
    assert.equal(await src.get(), undefined);
    assert.equal(fetchMock.mock.callCount(), 0);
    src.stop();
  } finally {
    fetchMock.mock.restore();
  }
});

test("license key: a 200 exchange caches the token; the cached token is served without refetching", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "http://billing.test/api/entitlement");
    assert.equal(JSON.parse(String(init?.body)).licenseKey, "mf_test");
    return jsonResponse(200, { token: "signed.token", exp: futureExp() });
  });
  try {
    const src = createEntitlementTokenSource({
      MIRAFOLD_LICENSE_KEY: "mf_test",
      MIRAFOLD_ENTITLEMENT_URL: "http://billing.test/api/entitlement",
    });
    assert.equal(src.mode, "license-key");
    assert.equal(await src.get(), "signed.token");
    assert.equal(await src.get(), "signed.token");
    // Boot warm-up is the single flight both get()s rode — no extra calls.
    assert.equal(fetchMock.mock.callCount(), 1);
    src.stop();
  } finally {
    fetchMock.mock.restore();
  }
});

test("license key refused (403): get() is undefined and does not hammer the endpoint", async () => {
  const warn = mock.method(console, "warn", () => {});
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    jsonResponse(403, { reason: "subscription lapsed" }),
  );
  try {
    const src = createEntitlementTokenSource({
      MIRAFOLD_LICENSE_KEY: "mf_lapsed",
      MIRAFOLD_ENTITLEMENT_URL: "http://billing.test/api/entitlement",
    });
    assert.equal(await src.get(), undefined);
    assert.equal(await src.get(), undefined);
    assert.equal(await src.get({ refresh: true }), undefined); // throttled — within the 60s gap
    assert.equal(fetchMock.mock.callCount(), 1);
    // Exactly one actionable line, and it never prints the full key.
    const lines = warn.mock.calls.map((c) => String(c.arguments[0]));
    assert.equal(lines.filter((l) => l.includes("entitlement refused")).length, 1);
    assert.ok(!lines.some((l) => l.includes("mf_lapsed")));
    src.stop();
  } finally {
    fetchMock.mock.restore();
    warn.mock.restore();
  }
});

test("endpoint down: a cached unexpired token keeps being served", async () => {
  let up = true;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    if (!up) throw new TypeError("fetch failed");
    return jsonResponse(200, { token: "cached.token", exp: futureExp() });
  });
  try {
    const src = createEntitlementTokenSource({
      MIRAFOLD_LICENSE_KEY: "mf_test",
      MIRAFOLD_ENTITLEMENT_URL: "http://billing.test/api/entitlement",
    });
    assert.equal(await src.get(), "cached.token");
    up = false;
    // Forced refresh is throttled here (inside the 60s gap) — but even when a
    // refetch DID happen and failed, the posture is: serve the cached token.
    assert.equal(await src.get({ refresh: true }), "cached.token");
    src.stop();
  } finally {
    fetchMock.mock.restore();
  }
});

test("malformed exchange response degrades to no token, never throws", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => jsonResponse(200, { nope: true }));
  try {
    const src = createEntitlementTokenSource({
      MIRAFOLD_LICENSE_KEY: "mf_test",
      MIRAFOLD_ENTITLEMENT_URL: "http://billing.test/api/entitlement",
    });
    assert.equal(await src.get(), undefined);
    src.stop();
  } finally {
    fetchMock.mock.restore();
  }
});
