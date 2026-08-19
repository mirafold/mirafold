import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acting,
  confirmLede,
  day,
  describeSubscription,
  loading,
  onReply,
  type SubscriptionReply,
} from "./subscription-card";

// Phase CS: the card's pure brain. The component only renders these
// decisions, so this is where the flow's correctness is pinned.

const reply = (over: Partial<SubscriptionReply>): SubscriptionReply => ({
  type: "subscription",
  id: "sub-1",
  ...over,
});

test("CS: replies correlate by id — the awaited one lands, strangers are dropped", () => {
  const s0 = loading("sub-1");
  assert.equal(onReply(s0, reply({ id: "sub-OTHER", status: "active" })), s0);
  const s1 = onReply(s0, reply({ status: "active", periodEnd: "2026-09-01T12:00:00Z" }));
  assert.equal(s1.phase, "ready");
  // A late duplicate can't knock a settled card back around.
  assert.equal(onReply(s1, reply({ status: "canceled" })), s1);
});

test("CS: an error reply fails the card with the daemon's own line", () => {
  const s = onReply(acting("sub-2"), reply({ id: "sub-2", error: "billing backend unreachable" }));
  assert.deepEqual(s, { phase: "failed", message: "billing backend unreachable" });
});

test("CS: the status lines and their one offered action", () => {
  assert.deepEqual(
    describeSubscription(reply({ status: "trialing", periodEnd: "2026-08-17T12:00:00Z" })),
    { line: "free trial — first charge Aug 17, 2026", action: "cancel" },
  );
  assert.deepEqual(
    describeSubscription(reply({ status: "active", periodEnd: "2026-09-01T12:00:00Z" })),
    { line: "active — renews Sep 1, 2026", action: "cancel" },
  );
  // A scheduled cancel wins the line regardless of status, and flips the
  // action to undo — the whole point of shipping uncancel.
  assert.deepEqual(
    describeSubscription(
      reply({ status: "active", periodEnd: "2026-09-01T12:00:00Z", cancelAt: "2026-09-01T12:00:00Z" }),
    ),
    { line: "cancellation scheduled — access ends Sep 1, 2026", action: "uncancel" },
  );
  assert.deepEqual(describeSubscription(reply({ status: "canceled" })), {
    line: "subscription ended",
    action: null,
  });
  assert.equal(describeSubscription(reply({ status: "past_due" })).action, "cancel");
  assert.deepEqual(describeSubscription(reply({ status: "paused" })), {
    line: "subscription is paused",
    action: null,
  });
});

test("CS: the confirm copy stays true to the refund policy — trial = never charged, paid = end of period", () => {
  assert.equal(
    confirmLede(reply({ status: "trialing", periodEnd: "2026-08-17T12:00:00Z" })),
    "Cancel now and you'll never be charged. Your trial access still runs to Aug 17, 2026.",
  );
  assert.equal(
    confirmLede(reply({ status: "active", periodEnd: "2026-09-01T12:00:00Z" })),
    "You won't be charged again. Access runs to Sep 1, 2026, then the subscription ends.",
  );
});

test("CS: garbled dates degrade to dateless lines, never 'Invalid Date'", () => {
  assert.equal(day("not-a-date"), null);
  assert.equal(day(undefined), null);
  assert.deepEqual(describeSubscription(reply({ status: "trialing", periodEnd: "garbage" })), {
    line: "free trial",
    action: "cancel",
  });
  assert.ok(!confirmLede(reply({ status: "active", periodEnd: "garbage" })).includes("Invalid"));
});
