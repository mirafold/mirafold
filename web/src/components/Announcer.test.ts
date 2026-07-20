import { test } from "node:test";
import assert from "node:assert/strict";
import { turnResponse } from "./Announcer";

// A.1: what a screen reader hears at turn_end. The cap and the no-prose
// fallback are the two edges — a silent turn (tool work only) must still
// announce something, and a huge dump must not read for minutes.

test("turnResponse speaks the response when there is prose", () => {
  assert.equal(turnResponse("  Here is the answer.  "), "Here is the answer.");
});

test("turnResponse falls back when the turn produced no prose", () => {
  assert.equal(turnResponse(""), "Turn complete.");
  assert.equal(turnResponse("   \n  "), "Turn complete.");
});

test("turnResponse caps a long response and points at the transcript", () => {
  const spoken = turnResponse("x".repeat(5000));
  assert.match(spoken, /the full text is in the transcript\.$/);
  assert.ok(spoken.startsWith("x".repeat(4000)));
  assert.ok(!spoken.includes("x".repeat(4001)));
});

test("turnResponse leaves a response exactly at the cap intact", () => {
  const exact = "y".repeat(4000);
  assert.equal(turnResponse(exact), exact);
});
