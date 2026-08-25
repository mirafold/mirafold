import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../protocol";
import { SessionRegistry } from "./registry";
import { openConnection, type Connection } from "./connection";
import type { SubscriptionActions, SubscriptionResult } from "../relay/subscription";
import type { Backend } from "../adapters";

// Phase CS at the connection layer: the hello's `billing` flag and the three
// subscription_* handlers, openConnection driven directly (the fleet-acts
// harness) with a fake SubscriptionActions in hand.

const NONE: Backend = { agent: "claude-code", kind: "none", live: false };

function fakeActions(result: SubscriptionResult = { view: { status: "active" } }) {
  const calls: string[] = [];
  const act = (name: string) => () => {
    calls.push(name);
    return Promise.resolve(result);
  };
  const actions: SubscriptionActions = {
    status: act("status"),
    cancel: act("cancel"),
    uncancel: act("uncancel"),
  };
  return { actions, calls };
}

function conn(remote: boolean, actions?: SubscriptionActions) {
  const reg = new SessionRegistry({ backend: NONE });
  const seen: WireMsg[] = [];
  const c = openConnection(reg, (m) => seen.push(m), { label: "test", remote, subscription: actions });
  return { c, seen };
}
const send = (c: Connection, msg: unknown) => c.handleMessage(JSON.stringify(msg));
const replies = (seen: WireMsg[]) =>
  seen.filter((m) => m.type === "subscription") as Extract<WireMsg, { type: "subscription" }>[];
const settle = () => new Promise((r) => setImmediate(r));

test("CS: the billing hello flag is local-only and actions-only", () => {
  const { actions } = fakeActions();
  const hello = (remote: boolean, a?: SubscriptionActions) =>
    conn(remote, a).seen.find((m) => m.type === "agents") as { billing?: string };
  assert.equal(hello(false, actions).billing, "license-key");
  assert.equal(hello(true, actions).billing, undefined, "remote viewports never see the flag");
  assert.equal(hello(false, undefined).billing, undefined, "no license key, no affordance");
});

test("CS: a status request round-trips the view with the echoed id", async () => {
  const { actions } = fakeActions({
    view: { status: "trialing", periodEnd: "2026-08-17T00:00:00Z" },
  });
  const { c, seen } = conn(false, actions);
  send(c, { type: "subscription_status", id: "s1" });
  await settle();
  assert.deepEqual(replies(seen), [
    { type: "subscription", id: "s1", status: "trialing", periodEnd: "2026-08-17T00:00:00Z" },
  ]);
});

test("CS: an error result answers as error, same echoed id", async () => {
  const { actions } = fakeActions({ error: "billing backend unreachable" });
  const { c, seen } = conn(false, actions);
  send(c, { type: "subscription_cancel", id: "c1" });
  await settle();
  assert.deepEqual(replies(seen), [
    { type: "subscription", id: "c1", error: "billing backend unreachable" },
  ]);
});

test("CS: a remote viewport's crafted cancel is refused and never reaches the backend", async () => {
  // The hello flag gates the UI; this gates the action — a crafted frame is
  // cheap, and the key's actions stay on the machine that holds it.
  const { actions, calls } = fakeActions();
  const { c, seen } = conn(true, actions);
  send(c, { type: "subscription_cancel", id: "r1" });
  await settle();
  assert.equal(replies(seen).length, 1);
  assert.match(replies(seen)[0].error!, /desktop/);
  assert.deepEqual(calls, []);
});

test("CS: a daemon with no subscription answers every request with an error, not silence", async () => {
  const { c, seen } = conn(false, undefined);
  for (const type of ["subscription_status", "subscription_cancel", "subscription_uncancel"]) {
    send(c, { type, id: `x-${type}` });
  }
  await settle();
  assert.equal(replies(seen).length, 3);
  assert.ok(replies(seen).every((r) => r.error?.includes("no subscription")));
});

test("CS: rapid repeats are throttled with a reply, and only one call goes out", async () => {
  const { actions, calls } = fakeActions();
  const { c, seen } = conn(false, actions);
  send(c, { type: "subscription_cancel", id: "t1" });
  send(c, { type: "subscription_cancel", id: "t2" });
  await settle();
  assert.deepEqual(calls, ["cancel"], "the second burst never reached the backend");
  const second = replies(seen).find((r) => r.id === "t2");
  assert.match(second!.error!, /in flight/);
});

test("CS: a malformed id is dropped without a crash or a reply", async () => {
  const { actions, calls } = fakeActions();
  const { c, seen } = conn(false, actions);
  send(c, { type: "subscription_status", id: 42 });
  send(c, { type: "subscription_status" });
  await settle();
  assert.equal(replies(seen).length, 0);
  assert.deepEqual(calls, []);
});
