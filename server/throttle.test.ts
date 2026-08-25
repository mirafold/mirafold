import { test } from "node:test";
import assert from "node:assert/strict";
import { inflightSlot, minInterval, tokenBucket } from "./throttle";

test("minInterval admits one take per window", () => {
  let t = 0;
  const gate = minInterval(250, () => t);
  assert.equal(gate.take(), true);
  t = 100;
  assert.equal(gate.take(), false);
  t = 250;
  assert.equal(gate.take(), true);
});

test("tokenBucket allows one burst, refills continuously, never exceeds the burst", () => {
  let t = 0;
  const bucket = tokenBucket(4, () => t);
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, true, false]);
  t = 250; // a quarter second refills one token
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  t = 10_000; // a long idle caps at one burst, not ten
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, true, false]);
});

test("inflightSlot holds one operation until released", () => {
  const slot = inflightSlot();
  assert.equal(slot.take(), true);
  assert.equal(slot.busy, true);
  assert.equal(slot.take(), false);
  slot.release();
  assert.equal(slot.take(), true);
});
