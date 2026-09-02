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
      view: { status: "active", cancelAt: "soon" },
    });
  } finally {
    m.mock.restore();
  }
});

test("CS: the throttle admits one in-flight action and floors restarts", () => {
  const t = createSubscriptionThrottle(60_000);
  assert.equal(t.tryStart(), true);
  assert.equal(t.tryStart(), false, "second start while in flight is refused");
  t.done();
  assert.equal(t.tryStart(), false, "the min gap holds even after completion");
});
