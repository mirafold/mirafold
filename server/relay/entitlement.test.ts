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

test("oversized billing JSON and entitlement tokens degrade to no token", async () => {
  for (const body of [
    { token: "x".repeat(70_000), exp: futureExp() },
    { token: "x".repeat(9_000), exp: futureExp() },
  ]) {
    const fetchMock = mock.method(globalThis, "fetch", async () => jsonResponse(200, body));
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
  }
});

// AUDIT 2026-08-26: no key bytes in the log, not even a prefix.
test("AUDIT: a refused license key is never echoed into the log, not even its prefix", async () => {
  const lines: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => lines.push(args.map(String).join(" ")));
  const error = mock.method(console, "error", (...args: unknown[]) => lines.push(args.map(String).join(" ")));
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    jsonResponse(403, { reason: "lapsed" }),
  );
  const source = createEntitlementTokenSource({
    MIRAFOLD_LICENSE_KEY: "mf_SECRETSECRETSECRET",
    MIRAFOLD_ENTITLEMENT_URL: "http://billing.test/api/entitlement",
  });
  try {
    assert.equal(await source.get(), undefined);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.ok(lines.some((line) => line.includes("entitlement refused")), lines.join(" | "));
  } finally {
    source.stop();
    fetchMock.mock.restore();
    warn.mock.restore();
    error.mock.restore();
  }
  assert.ok(!lines.some((l) => l.includes("mf_SEC")), lines.join(" | "));
});

// Phase PB.2: the source's READ for the pair card — every exchange outcome
// sets it, listeners hear only changes, and `unreachable` says whether an
// unexpired token still carries the relay meanwhile.
test("license key: the read starts checking, then follows each exchange outcome; listeners hear changes only", async () => {
  let answer: () => Response = () => jsonResponse(200, { token: "t1", exp: futureExp() });
  const fetchMock = mock.method(globalThis, "fetch", async () => answer());
  // A forced re-exchange is throttled to once a minute (a lapsed key must not
  // turn dial backoff into an HTTP hammer) — the clock has to move for it.
  mock.timers.enable({ apis: ["Date"] });
  try {
    const src = createEntitlementTokenSource({
      MIRAFOLD_LICENSE_KEY: "mf_test",
      MIRAFOLD_ENTITLEMENT_URL: "http://billing.test/api/entitlement",
    });
    const heard: string[] = [];
    const off = src.onChange((v) => heard.push(`${v.state}${v.reason ? ":" + v.reason : ""}${v.cached ? ":cached" : ""}`));
    assert.deepEqual(src.state(), { state: "checking" });
    await src.get();
    assert.deepEqual(src.state(), { state: "valid" });

    // A lapse at the next (forced) exchange: refused, the reason quoted, capped.
    answer = () => jsonResponse(403, { reason: "x".repeat(500) });
    mock.timers.tick(61_000);
    await src.get({ refresh: true });
    assert.equal(src.state()?.state, "invalid");
    assert.equal(src.state()?.reason?.length, 200);

    // Outage with nothing cached (the 403 cleared it): unreachable, uncached.
    answer = () => {
      throw new Error("ECONNREFUSED");
    };
    // The minute gap throttles a stale-cache refetch too — move the clock again.
    mock.timers.tick(61_000);
    await src.get();
    assert.deepEqual(src.state(), { state: "unreachable", cached: false });
    await src.get(); // same read again → no second notification
    assert.deepEqual(heard, ["valid", "invalid:" + "x".repeat(200), "unreachable"]);
    off();
    src.stop();
  } finally {
    mock.timers.reset();
    fetchMock.mock.restore();
  }
});

test("outside license-key mode the read is undefined and listeners never fire", () => {
  const none = createEntitlementTokenSource({});
  assert.equal(none.state(), undefined);
  none.onChange(() => assert.fail("must not fire"))();
  const override = createEntitlementTokenSource({ MIRAFOLD_ENTITLEMENT_TOKEN: "hand.token" });
  assert.equal(override.state(), undefined);
  none.stop();
  override.stop();
});

// Review 2026-08-26: the backend's JSON is untrusted; a listener is someone
// else's code; a cached token's expiry is a read change of its own.
test("a 403 whose body is not {reason: string} — a number, null, an array — is still a refusal, quoted as nothing", async () => {
  for (const body of [{ reason: 42 }, null, [1, 2], "nope", { reason: ["a"] }]) {
    const fetchMock = mock.method(globalThis, "fetch", async () => jsonResponse(403, body));
    try {
      const src = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test", MIRAFOLD_ENTITLEMENT_URL: "http://b.test/api/entitlement" });
      await src.get();
      assert.deepEqual(src.state(), { state: "invalid" }, `body ${JSON.stringify(body)}`);
      src.stop();
    } finally {
      fetchMock.mock.restore();
    }
  }
});

test("a throwing listener neither relabels the read nor rejects the refresh", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => jsonResponse(200, { token: "t", exp: futureExp() }));
  try {
    const src = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test", MIRAFOLD_ENTITLEMENT_URL: "http://b.test/api/entitlement" });
    const heard: string[] = [];
    src.onChange(() => {
      throw new Error("subscriber bug");
    });
    src.onChange((v) => heard.push(v.state));
    await src.get(); // would reject here if the throw escaped exchange()
    assert.deepEqual(src.state(), { state: "valid" });
    assert.deepEqual(heard, ["valid"], "the listener after the throwing one still hears");
    src.stop();
  } finally {
    fetchMock.mock.restore();
  }
});

test("unreachable with a cached token flips to uncached when that token expires", async () => {
  let up = true;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    if (!up) throw new Error("ECONNREFUSED");
    return jsonResponse(200, { token: "t", exp: Math.floor(Date.now() / 1000) + 3600 });
  });
  mock.timers.enable({ apis: ["Date", "setTimeout"] });
  try {
    const src = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test", MIRAFOLD_ENTITLEMENT_URL: "http://b.test/api/entitlement" });
    const heard: string[] = [];
    src.onChange((v) => heard.push(`${v.state}${v.cached ? ":cached" : ""}`));
    await src.get();
    up = false;
    mock.timers.tick(61_000);
    await src.get({ refresh: true });
    assert.deepEqual(src.state(), { state: "unreachable", cached: true }, "the hour-long token still carries");
    mock.timers.tick(3600_000);
    assert.deepEqual(src.state(), { state: "unreachable", cached: false }, "expiry is a read change");
    assert.deepEqual(heard, ["valid", "unreachable:cached", "unreachable"]);
    src.stop();
  } finally {
    mock.timers.reset();
    fetchMock.mock.restore();
  }
});

test("a token living longer than a setTimeout can (>24.8 days) is watched in hops, not flipped at once", async () => {
  let up = true;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    if (!up) throw new Error("ECONNREFUSED");
    return jsonResponse(200, { token: "t", exp: Math.floor(Date.now() / 1000) + 40 * 24 * 3600 });
  });
  mock.timers.enable({ apis: ["Date", "setTimeout"] });
  try {
    const src = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test", MIRAFOLD_ENTITLEMENT_URL: "http://b.test/api/entitlement" });
    await src.get();
    up = false;
    mock.timers.tick(61_000);
    await src.get({ refresh: true });
    assert.deepEqual(src.state(), { state: "unreachable", cached: true });
    mock.timers.tick(2 ** 31); // past one hop: still carrying
    assert.deepEqual(src.state(), { state: "unreachable", cached: true });
    mock.timers.tick(40 * 24 * 3600 * 1000); // past expiry
    assert.deepEqual(src.state(), { state: "unreachable", cached: false });
    src.stop();
  } finally {
    mock.timers.reset();
    fetchMock.mock.restore();
  }
});
