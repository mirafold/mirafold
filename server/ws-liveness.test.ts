import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepLiveness, type Pingable } from "./ws-liveness";

function fakeWs() {
  return {
    pinged: 0,
    terminated: 0,
    ping() {
      this.pinged++;
    },
    terminate() {
      this.terminated++;
    },
  };
}

test("sweep pings a live socket and marks it pending (not yet reaped)", () => {
  const ws = fakeWs();
  const alive = new Map<Pingable, boolean>([[ws, true]]);
  const reaped = sweepLiveness([ws], alive);
  assert.equal(reaped, 0);
  assert.equal(ws.pinged, 1);
  assert.equal(ws.terminated, 0);
  assert.equal(alive.get(ws), false, "marked pending until its pong flips it back");
});

test("sweep terminates a socket that missed its pong (the ghost path)", () => {
  const ws = fakeWs();
  const alive = new Map<Pingable, boolean>([[ws, false]]);
  const reaped = sweepLiveness([ws], alive);
  assert.equal(reaped, 1);
  assert.equal(ws.terminated, 1, "terminate() fires 'close' → detach");
  assert.equal(ws.pinged, 0);
});

test("a socket that ponged between ticks survives the next tick", () => {
  const ws = fakeWs();
  const alive = new Map<Pingable, boolean>([[ws, true]]);
  sweepLiveness([ws], alive); // tick 1: ping, mark pending
  alive.set(ws, true); // its pong arrives → alive again
  const reaped = sweepLiveness([ws], alive); // tick 2
  assert.equal(reaped, 0);
  assert.equal(ws.terminated, 0);
  assert.equal(ws.pinged, 2);
});

test("across a mixed fleet only the silent sockets are reaped", () => {
  const live = fakeWs();
  const dead = fakeWs();
  const alive = new Map<Pingable, boolean>([
    [live, true],
    [dead, false],
  ]);
  const reaped = sweepLiveness([live, dead], alive);
  assert.equal(reaped, 1);
  assert.equal(dead.terminated, 1);
  assert.equal(live.terminated, 0);
  assert.equal(live.pinged, 1);
});
