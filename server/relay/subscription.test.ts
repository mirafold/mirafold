import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createSubscriptionActions,
  createSubscriptionThrottle,
  subscriptionBase,
  SUPPORT_FALLBACK,
} from "./subscription";

// Phase CS: the daemon's billing-backend client. Everything here runs against
// a mocked fetch — no test may ever reach the real billing backend, let alone
// Paddle behind it.

const KEY = "mf_abcdefghijklmnopqrstuvwxyz";

test("CS: active only in license-key mode — override, keyless, and underivable URLs get nothing", () => {
  assert.equal(createSubscriptionActions({}), undefined);
  assert.equal(
    createSubscriptionActions({ MIRAFOLD_ENTITLEMENT_TOKEN: "tok.x", MIRAFOLD_LICENSE_KEY: KEY }),
    undefined,
    "the ops override has no key in play",
  );
  assert.equal(
    createSubscriptionActions({
      MIRAFOLD_LICENSE_KEY: KEY,
      MIRAFOLD_ENTITLEMENT_URL: "https://self.host/exchange",
    }),
    undefined,
    "a custom exchange URL we can't derive siblings from turns the feature off, never guesses",
  );
  assert.notEqual(createSubscriptionActions({ MIRAFOLD_LICENSE_KEY: KEY }), undefined);
});

test("CS: endpoint derivation strips /entitlement, nothing else", () => {
  assert.equal(
    subscriptionBase("https://mirafold.com/api/entitlement"),
    "https://mirafold.com/api/subscription",
  );
  assert.equal(
    subscriptionBase("http://127.0.0.1:9999/api/entitlement/"),
    "http://127.0.0.1:9999/api/subscription",
  );
  assert.equal(subscriptionBase("https://self.host/exchange"), undefined);
});

test("CS: the three actions hit the derived endpoints with the key, and a view round-trips", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const m = mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({
      status: "active",
      periodEnd: "2026-09-01T00:00:00Z",
      cancelAt: null,
    });
  });
  try {
    const actions = createSubscriptionActions({ MIRAFOLD_LICENSE_KEY: KEY })!;
    const s = await actions.status();
    await actions.cancel();
    await actions.uncancel();
    assert.deepEqual(
      calls.map((c) => c.url),
      [
        "https://mirafold.com/api/subscription",
        "https://mirafold.com/api/subscription/cancel",
        "https://mirafold.com/api/subscription/uncancel",
      ],
    );
    assert.ok(calls.every((c) => (c.body as { licenseKey: string }).licenseKey === KEY));
    // The null cancelAt is dropped, not forwarded as a null on the wire.
    assert.deepEqual(s, { view: { status: "active", periodEnd: "2026-09-01T00:00:00Z" } });
  } finally {
    m.mock.restore();
  }
});

test("CS: a backend refusal's reason surfaces, bounded; malformed and down degrade to the support line", async () => {
  let mode: "refusal" | "malformed" | "down" = "refusal";
  const m = mock.method(globalThis, "fetch", async () => {
    if (mode === "refusal") {
      return Response.json({ reason: `nope ${"x".repeat(500)}` }, { status: 403 });
    }
    if (mode === "malformed") return Response.json({ unexpected: true });
    throw new Error("network down");
  });
  try {
    const actions = createSubscriptionActions({ MIRAFOLD_LICENSE_KEY: KEY })!;
    const refusal = (await actions.status()) as { error: string };
    assert.ok(refusal.error.startsWith("nope "));
    assert.ok(refusal.error.length <= 200, "a self-hoster's arbitrary reason text is bounded");
    mode = "malformed";
    assert.deepEqual(await actions.status(), { error: SUPPORT_FALLBACK });
    mode = "down";
    assert.deepEqual(await actions.status(), { error: SUPPORT_FALLBACK });
  } finally {
    m.mock.restore();
  }
});

test("CS: oversized billing JSON and date fields never reach the subscription view", async () => {
  let oversizedBody = true;
  const m = mock.method(globalThis, "fetch", async () =>
    oversizedBody
      ? Response.json({ status: "active", padding: "x".repeat(70_000) })
      : Response.json({ status: "active", periodEnd: "x".repeat(65), cancelAt: "soon" }),
  );
  try {
    const actions = createSubscriptionActions({ MIRAFOLD_LICENSE_KEY: KEY })!;
    assert.deepEqual(await actions.status(), { error: SUPPORT_FALLBACK });
    oversizedBody = false;
    assert.deepEqual(await actions.status(), {
      view: { status: "active" },
    });
  } finally {
    m.mock.restore();
  }
});

test("DA.5: only known subscription states and strict ISO instants reach the shell", async (t) => {
  let body: Record<string, unknown> = { status: "active" };
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const actions = createSubscriptionActions({ MIRAFOLD_LICENSE_KEY: KEY })!;
  try {
    for (const status of ["\u202eactive — renewed", "active\nsubscription ended", "future_status", "x".repeat(100)]) {
      body = { status, periodEnd: "not-a-date", cancelAt: "soon" };
      assert.deepEqual(await actions.status(), { view: { status: "unknown" } });
    }
    for (const status of ["trialing", "active", "past_due", "paused", "canceled"]) {
      body = { status, periodEnd: "2026-09-01T00:00:00Z", cancelAt: null };
      assert.deepEqual(await actions.status(), {
        view: { status, periodEnd: "2026-09-01T00:00:00Z" },
      });
    }
    for (const malformed of ["soon", "0", "1", "999", "09/01/2026", "2026-09-01", "2026-02-30T00:00:00Z"]) {
      body = { status: "active", periodEnd: malformed, cancelAt: malformed };
      assert.deepEqual(await actions.status(), { view: { status: "active" } }, malformed);
    }
  } finally {
    fetch.mock.restore();
  }
});

test("CS: the throttle admits one in-flight action and floors restarts", () => {
  const t = createSubscriptionThrottle(60_000);
  assert.equal(t.tryStart(), true);
  assert.equal(t.tryStart(), false, "second start while in flight is refused");
  t.done();
  assert.equal(t.tryStart(), false, "the min gap holds even after completion");
});

test("DA.3: every billing string removes the exact license key before any truncation", async (t) => {
  const actions = createSubscriptionActions({ MIRAFOLD_LICENSE_KEY: KEY })!;
  for (const [status, body] of [
    [403, { reason: `prefix${KEY}${KEY}: refused` }],
    [400, { error: `bad ${KEY}` }],
    [403, { reason: `${"x".repeat(195)}${KEY}` }],
    [200, { status: `${"x".repeat(35)}${KEY}`, periodEnd: KEY, cancelAt: `date ${KEY}` }],
  ] as const) {
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(body, { status }));
    try {
      for (const act of [actions.status, actions.cancel, actions.uncancel]) {
        const result = JSON.stringify(await act());
        assert.ok(!result.includes(KEY));
        assert.ok(!result.includes("mf_"), "clipping retained the beginning of the credential");
        if (status !== 200) {
          assert.ok(result.includes("[lice"), "a displayed refusal must retain the replacement marker");
        }
      }
    } finally { fetch.mock.restore(); }
  }
});

test("DA.5 cold review: status redaction precedes the known-state allowlist", async (t) => {
  const licenseKey = "active";
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ status: licenseKey }));
  try {
    const actions = createSubscriptionActions({ MIRAFOLD_LICENSE_KEY: licenseKey })!;
    const result = await actions.status();
    assert.deepEqual(result, { view: { status: "unknown" } });
    assert.ok(!JSON.stringify(result).includes(licenseKey), "the configured key reached the viewport result");
  } finally {
    fetch.mock.restore();
  }
});
