import { performance } from "node:perf_hooks";
import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createEntitlementTokenSource, type EntitlementView } from "./entitlement";

// The daemon's token source (R.5). These tests stub global fetch — the failure
// posture under test is "never throw, never block, degrade to no-token".

const futureExp = () => Math.floor(Date.now() / 1000) + 48 * 3600;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Node's Date mock advances civil time and relative timers, but deliberately
// leaves the monotonic performance clock alone. Keep elapsed time explicit in
// tests that exercise the one-minute request floor.
const elapsedClock = (t: TestContext) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  return {
    advance: (ms: number) => { now += ms; },
    tick: (ms: number) => {
      now += ms;
      t.mock.timers.tick(ms);
    },
  };
};

test("DA.4: unusable expiry metadata cannot advertise access or replace a usable cached token", async (t) => {
  // Bounded version of the expiry hunter: seconds must map to a finite,
  // future millisecond deadline, both at boot and while carrying a cache.
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const clock = elapsedClock(t);
  for (const carried of [false, true]) {
    for (const exp of [0, -1, Date.now() / 1000 - 1, Date.now() / 1000, Number.MAX_VALUE, null, "tomorrow"]) {
      let answer = carried ? { token: "carried.token", exp: futureExp() } : { token: "bad.token", exp };
      const fetch = t.mock.method(globalThis, "fetch", async () => jsonResponse(200, answer));
      const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
      try {
        if (carried) {
          assert.equal(await source.get(), "carried.token");
          answer = { token: "bad.token", exp };
          clock.tick(61_000);
        }
        assert.equal(await source.get({ refresh: carried }), carried ? "carried.token" : undefined);
        assert.deepEqual(source.state(), { state: "unreachable", cached: carried }, `expiry ${String(exp)}`);
      } finally { source.stop(); fetch.mock.restore(); }
    }
  }
});

test("DA.4: header-invalid exchanged and override tokens degrade without escaping the source", async (t) => {
  const invalid = ["bad\ntoken", "bad\0token", "bad☃token"];
  for (const token of invalid) {
    const fetch = t.mock.method(globalThis, "fetch", async () =>
      jsonResponse(200, { token, exp: futureExp() }));
    const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
    try {
      assert.equal(await source.get(), undefined, JSON.stringify(token));
      assert.deepEqual(source.state(), { state: "unreachable", cached: false });
    } finally { source.stop(); fetch.mock.restore(); }
  }

  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("an invalid override must suppress the key exchange");
  });
  try {
    for (const token of ["bad\ntoken", "bad☃token"]) {
      const source = createEntitlementTokenSource({
        MIRAFOLD_ENTITLEMENT_TOKEN: token,
        MIRAFOLD_LICENSE_KEY: "mf_fallback_must_not_run",
      });
      assert.equal(source.mode, "token-override");
      assert.equal(await source.get(), undefined);
      source.stop();
    }
    assert.equal(fetch.mock.callCount(), 0);

    // Node accepts Latin-1 in an HTTP header; do not invent a narrower token
    // grammar than the transport boundary requires.
    const valid = createEntitlementTokenSource({ MIRAFOLD_ENTITLEMENT_TOKEN: "custom.é" });
    assert.equal(await valid.get(), "custom.é");
    valid.stop();
  } finally { fetch.mock.restore(); }
});

test("DA.4: a header-invalid refresh cannot replace a usable cached token", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const clock = elapsedClock(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => jsonResponse(200, ++calls === 1
    ? { token: "carried.token", exp: futureExp() }
    : { token: "bad\ntoken", exp: futureExp() }));
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
  t.after(() => source.stop());
  assert.equal(await source.get(), "carried.token");
  clock.tick(61_000);
  assert.equal(await source.get({ refresh: true }), "carried.token");
  assert.deepEqual(source.state(), { state: "unreachable", cached: true });
});

test("DA.5: an exchanged token cannot contain the permanent license key", async (t) => {
  for (const licenseKey of [`mf_${"b".repeat(26)}`, "custom-license-value"]) {
    for (const token of [licenseKey, `prefix.${licenseKey}`, `${licenseKey}.suffix`]) {
      const fetch = t.mock.method(globalThis, "fetch", async () =>
        jsonResponse(200, { token, exp: futureExp() }));
      const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: licenseKey });
      try {
        assert.equal(await source.get(), undefined);
        assert.deepEqual(source.state(), { state: "unreachable", cached: false });
      } finally {
        source.stop();
        fetch.mock.restore();
      }
    }
  }

  const licenseKey = `mf_${"b".repeat(26)}`;
  const safe = "signed.token.with-no-permanent-credential";
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    jsonResponse(200, { token: safe, exp: futureExp() }));
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: licenseKey });
  try {
    assert.equal(await source.get(), safe);
    assert.deepEqual(source.state(), { state: "valid" });
  } finally {
    source.stop();
    fetch.mock.restore();
  }
});

test("DA.5 cold review: a short custom key does not reject an incidental token substring", async (t) => {
  const licenseKey = "a";
  for (const token of ["safe.token", "relay.token", "signed.payload"]) {
    const fetch = t.mock.method(globalThis, "fetch", async () =>
      jsonResponse(200, { token, exp: futureExp() }));
    const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: licenseKey });
    try {
      assert.equal(await source.get(), token);
      assert.deepEqual(source.state(), { state: "valid" });
    } finally {
      source.stop();
      fetch.mock.restore();
    }
  }

  const fetch = t.mock.method(globalThis, "fetch", async () =>
    jsonResponse(200, { token: licenseKey, exp: futureExp() }));
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: licenseKey });
  try {
    assert.equal(await source.get(), undefined, "exact reflection remains forbidden for every key length");
  } finally {
    source.stop();
    fetch.mock.restore();
  }
});

test("DA.5: a reflected refresh cannot displace an unexpired safe token", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const clock = elapsedClock(t);
  const licenseKey = `mf_${"c".repeat(26)}`;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => jsonResponse(200, ++calls === 1
    ? { token: "carried.safe.token", exp: futureExp() }
    : { token: `wrapped.${licenseKey}.credential`, exp: futureExp() }));
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: licenseKey });
  t.after(() => source.stop());
  assert.equal(await source.get(), "carried.safe.token");
  clock.tick(61_000);
  assert.equal(await source.get({ refresh: true }), "carried.safe.token");
  assert.deepEqual(source.state(), { state: "unreachable", cached: true });
});

test("DA.4: a fresh token's expiry gates pairing and refreshes without breaking the one-minute request floor", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const clock = elapsedClock(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => jsonResponse(200, {
    token: ++calls === 1 ? "short.token" : "renewed.token",
    exp: Date.now() / 1000 + (calls === 1 ? 1 : 3600),
  }));
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
  t.after(() => source.stop());
  const heard: string[] = [];
  source.onChange((view) => heard.push(view.state));
  assert.equal(await source.get(), "short.token");
  clock.tick(1000);
  assert.deepEqual(source.state(), { state: "checking" });
  assert.equal(await source.get(), undefined);
  clock.tick(58_999);
  assert.equal(calls, 1, "expiry must not create a billing request loop");
  clock.tick(1);
  assert.equal(calls, 2, "expiry must arrange a refresh without another caller");
  assert.equal(await source.get(), "renewed.token");
  assert.deepEqual(source.state(), { state: "valid" });
  assert.deepEqual(heard, ["valid", "checking", "valid"]);
  clock.tick(1000);
  assert.equal(calls, 2, "the replaced expiry timer must not refresh again");
});

for (const outcome of ["valid", "unreachable"] as const) {
  test(`DA.4: expiry during ${outcome} listener dispatch cannot leave access advertised`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
    const clock = elapsedClock(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls > 1) throw new Error("offline");
      return jsonResponse(200, { token: "short.token", exp: Date.now() / 1000 + 65 });
    });
    const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
    t.after(() => source.stop());
    let crossed = false;
    source.onChange((view) => {
      if (!crossed && view.state === outcome) {
        crossed = true;
        // Represents listener work or a scheduling pause crossing the
        // deadline between the exchange's decision and timer installation.
        t.mock.timers.setTime(1_800_000_066_000);
      }
    });
    await source.get();
    if (outcome === "unreachable") {
      clock.tick(61_000);
      await source.get({ refresh: true });
    }
    assert.equal(crossed, true);
    clock.tick(0);
    const state = source.state();
    assert.ok(state?.state !== "valid" && !(state?.state === "unreachable" && state.cached));
  });
}

for (const outcome of ["valid", "unreachable"] as const) {
  test(`DA.4: a forward wall-clock jump synchronously reconciles an expired ${outcome} read`, async (t) => {
    const start = 1_800_000_000_000;
    t.mock.timers.enable({ apis: ["Date"], now: start });
    const clock = elapsedClock(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls > 1) throw new Error("offline");
      return jsonResponse(200, { token: "clock.token", exp: start / 1000 + 3600 });
    });
    const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
    try {
      await source.get();
      if (outcome === "unreachable") {
        clock.tick(61_000);
        await source.get({ refresh: true });
      }
      t.mock.timers.setTime(start + 3_600_001);
      assert.deepEqual(
        source.state(),
        outcome === "valid" ? { state: "checking" } : { state: "unreachable", cached: false },
      );
    } finally { source.stop(); }
  });

  test(`DA.4: a connected ${outcome} listener hears a wall-clock expiry within one second`, async (t) => {
    const start = 1_800_000_000_000;
    const originalNow = Date.now;
    let now = start;
    Date.now = () => now;
    t.after(() => { Date.now = originalNow; });
    // Keep the relative timer clock independent from wall time, as libuv does.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const clock = elapsedClock(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls > 1) throw new Error("offline");
      return jsonResponse(200, { token: "clock.token", exp: start / 1000 + 3600 });
    });
    const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
    t.after(() => source.stop());
    let latest: EntitlementView | undefined;
    source.onChange((view) => { latest = view; });
    await source.get();
    if (outcome === "unreachable") {
      now += 61_000;
      clock.advance(61_000);
      await source.get({ refresh: true });
    }
    const advertisesAccess = () => latest?.state === "valid" || latest?.state === "unreachable" && latest.cached;
    assert.equal(advertisesAccess(), true);
    now = start + 3_600_001;
    clock.tick(999);
    assert.equal(advertisesAccess(), true, "the bounded timer fired before its one-second hop");
    clock.tick(1);
    assert.equal(advertisesAccess(), false, "the connected viewport kept expired access past one second");
  });
}

for (const outcome of ["valid", "unreachable"] as const) {
  test(`DA.4: a backward wall-clock correction cannot revive an expired ${outcome} token`, async (t) => {
    const start = 1_800_000_000_000;
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
    const clock = elapsedClock(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls > 1) throw new Error("offline");
      return jsonResponse(200, { token: "clock.token", exp: start / 1000 + 3_600 });
    });
    const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
    t.after(() => source.stop());

    await source.get();
    if (outcome === "unreachable") {
      clock.tick(61_000);
      await source.get({ refresh: true });
    }

    t.mock.timers.setTime(start + 3_600_001);
    assert.deepEqual(
      source.state(),
      outcome === "valid" ? { state: "checking" } : { state: "unreachable", cached: false },
    );
    t.mock.timers.setTime(start + 120_000);
    assert.equal(await source.get(), undefined, "an observed expiry must be irreversible for this cache entry");
    assert.deepEqual(
      source.state(),
      outcome === "valid" ? { state: "checking" } : { state: "unreachable", cached: false },
    );
  });
}

test("DA.4: a backward wall-clock correction cannot extend the one-minute forced-refresh floor", async (t) => {
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const clock = elapsedClock(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse(200, { token: `clock.token.${++calls}`, exp: start / 1000 + 7_200 }));
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
  t.after(() => source.stop());

  await source.get();
  t.mock.timers.setTime(start - 3_600_000);
  clock.tick(61_000);
  await source.get({ refresh: true });
  assert.equal(calls, 2);
});

test("DA.4: reentrant state reconciliation delivers each new read once", async (t) => {
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse(200, { token: "short.token", exp: start / 1000 + 1 }));
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
  t.after(() => source.stop());
  let reconciled = false;
  const second: EntitlementView[] = [];
  source.onChange((next) => {
    if (!reconciled && next.state === "valid") {
      reconciled = true;
      t.mock.timers.setTime(start + 1_001);
      source.state();
    }
  });
  source.onChange((next) => second.push({ ...next }));

  await source.get();
  assert.deepEqual(second, [{ state: "checking" }]);
});

test("DA.4: reentrant state reconciliation preserves its scheduled refresh", async (t) => {
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
  const clock = elapsedClock(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse(200, {
      token: ++calls === 1 ? "short.token" : "renewed.token",
      exp: Date.now() / 1000 + (calls === 1 ? 1 : 3_600),
    }));
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
  t.after(() => source.stop());
  let reconciled = false;
  source.onChange((next) => {
    if (!reconciled && next.state === "valid") {
      reconciled = true;
      t.mock.timers.setTime(start + 1_001);
      source.state();
    }
  });

  await source.get();
  clock.tick(0);
  assert.equal(calls, 1, "a wall-clock jump must not bypass the elapsed-time floor");
  clock.tick(59_999);
  assert.equal(calls, 1);
  clock.tick(1);
  assert.equal(calls, 2, "the expiry-arranged refresh was lost");
  assert.equal(await source.get(), "renewed.token");
});

test("DA.4: expiry during an in-flight refresh hides the old token and keeps the refresh single-flight", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const clock = elapsedClock(t);
  let resolve!: (response: Response) => void;
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => ++calls === 1
    ? Promise.resolve(jsonResponse(200, { token: "old.token", exp: Date.now() / 1000 + 65 }))
    : new Promise<Response>((done) => { resolve = done; }));
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
  t.after(() => source.stop());
  await source.get();
  clock.tick(61_000);
  const pending = source.get({ refresh: true });
  clock.tick(4000);
  assert.deepEqual(source.state(), { state: "checking" });
  resolve(jsonResponse(200, { token: "new.token", exp: futureExp() }));
  assert.equal(await pending, "new.token");
  assert.deepEqual(source.state(), { state: "valid" });
  clock.tick(60_000);
  assert.equal(calls, 2, "the old token must not leave a delayed refresh behind");
});

test("DA.4: a failed refresh that observes expiry retires the old cache before listeners run", async (t) => {
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
  const clock = elapsedClock(t);
  let calls = 0;
  let rejectRefresh!: (error: Error) => void;
  t.mock.method(globalThis, "fetch", () => {
    if (++calls === 1) {
      return Promise.resolve(jsonResponse(200, { token: "old.token", exp: start / 1000 + 65 }));
    }
    return new Promise<Response>((_resolve, reject) => { rejectRefresh = reject; });
  });
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
  t.after(() => source.stop());
  assert.equal(await source.get(), "old.token");

  clock.tick(61_000);
  const pending = source.get({ refresh: true });
  t.mock.timers.setTime(start + 66_000);
  source.onChange((next) => {
    if (next.state === "unreachable" && !next.cached) {
      t.mock.timers.setTime(start + 62_000);
    }
  });
  rejectRefresh(new Error("offline"));

  assert.equal(await pending, undefined);
  assert.equal(calls, 2);
  assert.deepEqual(source.state(), { state: "unreachable", cached: false });
});

test("DA.4: stopping before the boot exchange completes cannot leave an automatic expiry refresh", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  let resolve!: (response: Response) => void;
  const fetch = t.mock.method(globalThis, "fetch", () => new Promise<Response>((done) => { resolve = done; }));
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
  t.after(() => source.stop());
  const pending = source.get();
  source.stop();
  resolve(jsonResponse(200, { token: "short.token", exp: Date.now() / 1000 + 1 }));
  await pending;
  t.mock.timers.tick(60_001);
  assert.equal(fetch.mock.callCount(), 1);
});

test("DA.3: reflected license values are removed before refusal text is clipped or published", async (t) => {
  // Terminal mode historically accepts an arbitrary supplied key, so the
  // exact-value guard must work independently of the logger's shaped pattern.
  const key = "custom-license-value";
  for (const raw of [`refused ${key}${key}`, `${"x".repeat(195)}${key}`]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => jsonResponse(403, { reason: raw }));
    const warn = t.mock.method(console, "warn", () => {});
    const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: key });
    try {
      await source.get();
      const reason = source.state()?.reason;
      assert.equal(reason, raw.split(key).join("[license key]").slice(0, 200));
      assert.ok(!reason?.includes("custom"));
      assert.ok(warn.mock.calls.every((call) => !String(call.arguments[0]).includes(key)));
    } finally { source.stop(); fetch.mock.restore(); warn.mock.restore(); }
  }
});

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
test("license key: the read starts checking, then follows each exchange outcome; listeners hear changes only", async (t) => {
  let answer: () => Response = () => jsonResponse(200, { token: "t1", exp: futureExp() });
  const fetchMock = mock.method(globalThis, "fetch", async () => answer());
  // A forced re-exchange is throttled to once a minute (a lapsed key must not
  // turn dial backoff into an HTTP hammer) — the clock has to move for it.
  t.mock.timers.enable({ apis: ["Date"] });
  const clock = elapsedClock(t);
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
    clock.tick(61_000);
    await src.get({ refresh: true });
    assert.equal(src.state()?.state, "invalid");
    assert.equal(src.state()?.reason?.length, 200);

    // Outage with nothing cached (the 403 cleared it): unreachable, uncached.
    answer = () => {
      throw new Error("ECONNREFUSED");
    };
    // The minute gap throttles a stale-cache refetch too — move the clock again.
    clock.tick(61_000);
    await src.get();
    assert.deepEqual(src.state(), { state: "unreachable", cached: false });
    await src.get(); // same read again → no second notification
    assert.deepEqual(heard, ["valid", "invalid:" + "x".repeat(200), "unreachable"]);
    off();
    src.stop();
  } finally {
    t.mock.timers.reset();
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

test("DA.4: an unprintable thrown listener value cannot reject the refresh or skip listeners", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse(200, { token: "t", exp: futureExp() }));
  const source = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test" });
  t.after(() => source.stop());
  const heard: string[] = [];
  source.onChange(() => {
    throw { toString: () => { throw new Error("unprintable thrown value"); } };
  });
  source.onChange((next) => heard.push(next.state));

  const rejected = await source.get().then(() => false, () => true);
  assert.equal(rejected, false);
  assert.deepEqual(source.state(), { state: "valid" });
  assert.deepEqual(heard, ["valid"]);
});

test("unreachable with a cached token flips to uncached when that token expires", async (t) => {
  let up = true;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    if (!up) throw new Error("ECONNREFUSED");
    return jsonResponse(200, { token: "t", exp: Math.floor(Date.now() / 1000) + 3600 });
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const clock = elapsedClock(t);
  try {
    const src = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test", MIRAFOLD_ENTITLEMENT_URL: "http://b.test/api/entitlement" });
    const heard: string[] = [];
    src.onChange((v) => heard.push(`${v.state}${v.cached ? ":cached" : ""}`));
    await src.get();
    up = false;
    clock.tick(61_000);
    await src.get({ refresh: true });
    assert.deepEqual(src.state(), { state: "unreachable", cached: true }, "the hour-long token still carries");
    clock.tick(3600_000);
    assert.deepEqual(src.state(), { state: "unreachable", cached: false }, "expiry is a read change");
    assert.deepEqual(heard, ["valid", "unreachable:cached", "unreachable"]);
    src.stop();
  } finally {
    t.mock.timers.reset();
    fetchMock.mock.restore();
  }
});

test("a token living longer than a setTimeout can (>24.8 days) is watched in hops, not flipped at once", async (t) => {
  let up = true;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    if (!up) throw new Error("ECONNREFUSED");
    return jsonResponse(200, { token: "t", exp: Math.floor(Date.now() / 1000) + 40 * 24 * 3600 });
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const clock = elapsedClock(t);
  try {
    const src = createEntitlementTokenSource({ MIRAFOLD_LICENSE_KEY: "mf_test", MIRAFOLD_ENTITLEMENT_URL: "http://b.test/api/entitlement" });
    await src.get();
    up = false;
    clock.tick(61_000);
    await src.get({ refresh: true });
    assert.deepEqual(src.state(), { state: "unreachable", cached: true });
    clock.tick(2 ** 31); // past one hop: still carrying
    assert.deepEqual(src.state(), { state: "unreachable", cached: true });
    clock.tick(40 * 24 * 3600 * 1000); // past expiry
    assert.deepEqual(src.state(), { state: "unreachable", cached: false });
    src.stop();
  } finally {
    t.mock.timers.reset();
    fetchMock.mock.restore();
  }
});
