import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPins, savePins } from "./pin-store";

const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

test("pins round-trip per session, and an empty list removes the entry", () => {
  const s = fakeStorage();
  savePins("a", ["r1", "r2"], s);
  savePins("b", ["x"], s);
  assert.deepEqual(loadPins("a", s), ["r1", "r2"]);
  assert.deepEqual(loadPins("b", s), ["x"]);
  savePins("a", [], s);
  assert.equal(s.map.has("mirafold-pins-a"), false);
  assert.deepEqual(loadPins("a", s), []);
});

test("a corrupt or foreign value never throws and yields no pins", () => {
  const s = fakeStorage();
  s.map.set("mirafold-pins-a", "{not json");
  assert.deepEqual(loadPins("a", s), []);
  s.map.set("mirafold-pins-a", JSON.stringify([1, "ok", null, { id: "no" }]));
  assert.deepEqual(loadPins("a", s), ["ok"]);
});

test("a throwing storage degrades to tab-local pins", () => {
  const throwing = {
    getItem: () => { throw new Error("private mode"); },
    setItem: () => { throw new Error("private mode"); },
    removeItem: () => { throw new Error("private mode"); },
  };
  assert.deepEqual(loadPins("a", throwing), []);
  assert.doesNotThrow(() => savePins("a", ["r1"], throwing));
  assert.doesNotThrow(() => savePins("a", [], throwing));
});

test("a hostile stored value is bounded on read: count and id length (audit 2026-08-31)", () => {
  const s = fakeStorage();
  const flood = Array.from({ length: 10_000 }, (_, i) => `id-${i}`);
  s.map.set("mirafold-pins-a", JSON.stringify(flood));
  assert.equal(loadPins("a", s).length, 100, "the count cap fires before anything derives from the list");
  s.map.set("mirafold-pins-a", JSON.stringify(["ok", "x".repeat(129), "y".repeat(128)]));
  assert.deepEqual(loadPins("a", s), ["ok", "y".repeat(128)], "an overlong id is dropped; the boundary length is kept");
});
