import { test } from "node:test";
import assert from "node:assert/strict";
import { relayRefusalReason } from "./relay-client";
import {
  CLOSE_BAD_CODE,
  CLOSE_CODE_TAKEN,
  CLOSE_OVERLOADED,
  CLOSE_UNENTITLED,
} from "./relay-protocol";

// The dial-out refusal map: a relay close code the daemon can EXPLAIN vs. a
// routine drop it just retries. Keeps the paying-user failure modes (bad token
// = 4007, relay full = 4004) from reading as a silent reconnect loop.
test("relayRefusalReason: known refusals get an actionable line", () => {
  assert.match(relayRefusalReason(CLOSE_UNENTITLED)!, /subscription/);
  assert.match(relayRefusalReason(CLOSE_OVERLOADED)!, /capacity/);
  assert.match(relayRefusalReason(CLOSE_CODE_TAKEN)!, /already held/);
});

test("relayRefusalReason: an ordinary drop is not a refusal (null → retry quietly)", () => {
  // A normal close (1000/1006) or a not-paired code is a connection loss, not a
  // refusal the user must act on — the caller falls back to the generic path.
  assert.equal(relayRefusalReason(1000), null); // normal close
  assert.equal(relayRefusalReason(1006), null); // abnormal/transport drop
  assert.equal(relayRefusalReason(CLOSE_BAD_CODE), null); // no daemon under that id — transient race
});
