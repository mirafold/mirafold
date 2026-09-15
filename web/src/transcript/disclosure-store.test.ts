import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISCLOSURE_MAX_ENTRIES,
  loadDetailsMode,
  loadDisclosure,
  saveDetailsMode,
  saveDisclosure,
  withChoice,
} from "./disclosure-store";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

test("R6: the details mode is per session and per storage; absent reads compact", () => {
  const storage = memoryStorage();
  assert.equal(loadDetailsMode("s1", storage), false);
  saveDetailsMode("s1", true, storage);
  assert.equal(loadDetailsMode("s1", storage), true);
  assert.equal(loadDetailsMode("s2", storage), false, "another session keeps its own mode");
  saveDetailsMode("s1", false, storage);
  assert.equal(loadDetailsMode("s1", storage), false);
  assert.equal(storage.map.size, 0, "compact is the absence of a record");
});

test("R6: explicit choices round-trip by wire key and survive a reload of the same tab", () => {
  const storage = memoryStorage();
  let choices = new Map<string, boolean>();
  choices = withChoice(choices, "tool:t1", true);
  choices = withChoice(choices, "think:seq:9", false);
  saveDisclosure("s1", choices, storage);
  assert.deepEqual([...loadDisclosure("s1", storage)], [["tool:t1", true], ["think:seq:9", false]]);
  assert.deepEqual([...loadDisclosure("s2", storage)], []);
  saveDisclosure("s1", new Map(), storage);
  assert.equal(storage.map.size, 0);
});

test("R6: choices are bounded and the stored value is read back as untrusted", () => {
  let choices = new Map<string, boolean>();
  for (let i = 0; i < DISCLOSURE_MAX_ENTRIES + 10; i++) choices = withChoice(choices, `tool:${i}`, true);
  assert.equal(choices.size, DISCLOSURE_MAX_ENTRIES);
  assert.equal(choices.has("tool:0"), false, "the oldest choice leaves");
  assert.equal(choices.has(`tool:${DISCLOSURE_MAX_ENTRIES + 9}`), true);
  // Re-choosing moves an item to the newest slot instead of duplicating it.
  choices = withChoice(choices, "tool:20", false);
  assert.equal([...choices.keys()].at(-1), "tool:20");
  const storage = memoryStorage();
  storage.setItem("mirafold-disclosure-s1", JSON.stringify([["ok", true], ["bad", "yes"], 42, ["x".repeat(500), true]]));
  assert.deepEqual([...loadDisclosure("s1", storage)], [["ok", true]]);
  storage.setItem("mirafold-disclosure-s1", "{not json");
  assert.deepEqual([...loadDisclosure("s1", storage)], []);
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  assert.deepEqual([...loadDisclosure("s1", throwing)], []);
  assert.equal(loadDetailsMode("s1", throwing), false);
  assert.doesNotThrow(() => saveDisclosure("s1", choices, throwing));
});
