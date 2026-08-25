import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncQueue, CLOSE } from "./async-queue";

test("AsyncQueue hands items to waiters in order, buffers when nobody waits, and CLOSE is just an item", async () => {
  const q = new AsyncQueue<string | typeof CLOSE>();
  q.push("a");
  q.push("b");
  assert.equal(await q.next(), "a", "buffered items come out first-in first-out");
  assert.equal(await q.next(), "b");
  const pending = q.next(); // a waiter parked before anything arrives
  q.push("c");
  assert.equal(await pending, "c");
  const first = q.next();
  const second = q.next();
  q.push("d");
  q.push(CLOSE);
  assert.equal(await first, "d", "waiters are served in the order they parked");
  assert.equal(await second, CLOSE, "the close sentinel flows through like any item");
});
