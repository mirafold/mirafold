import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDirReply,
  beginDirFetch,
  bellRefreshDelay,
  childDirPaths,
  emptyDirStore,
  pruneDirStore,
  shownListing,
} from "./folder-tree";

// The lazy per-directory store: fetch-state transitions, the
// keep-entries-while-refetching rule (a refresh must never read as a
// collapse), error handling, the refresh-boundary prune, and the prefetch
// walk. All pure — the panel adds only correlation ids and requests.

test("first fetch: loading with nothing, then the reply loads entries + honest truncation", () => {
  let store = beginDirFetch(emptyDirStore(), "src");
  assert.deepEqual(store.get("src"), { phase: "loading" });
  store = applyDirReply(store, "src", {
    entries: [
      { name: "deep", kind: "dir" },
      { name: "app.ts", kind: "file" },
    ],
    truncated: true,
  });
  assert.deepEqual(store.get("src"), {
    phase: "ready",
    listing: {
      entries: [
        { name: "deep", kind: "dir" },
        { name: "app.ts", kind: "file" },
      ],
      truncated: true,
    },
  });
});

test("refetch keeps the previous entries visible while loading — never a collapse flash", () => {
  let store = applyDirReply(beginDirFetch(emptyDirStore(), ""), "", {
    entries: [{ name: "a.txt", kind: "file" }],
  });
  store = beginDirFetch(store, "");
  const st = store.get("")!;
  assert.equal(st.phase, "loading");
  assert.deepEqual(
    shownListing(st)?.entries,
    [{ name: "a.txt", kind: "file" }],
    "old rows stay during refetch",
  );
  store = applyDirReply(store, "", { entries: [{ name: "b.txt", kind: "file" }] });
  assert.deepEqual(shownListing(store.get("")!)?.entries, [{ name: "b.txt", kind: "file" }]);
});

test("an error reply keeps prior entries when there are any, and stands alone when there aren't", () => {
  // No prior listing: the error is all there is.
  const fresh = applyDirReply(beginDirFetch(emptyDirStore(), "x"), "x", {
    entries: [],
    error: "directory is not readable",
  });
  assert.deepEqual(fresh.get("x"), { phase: "error", error: "directory is not readable" });
  // A throttled REFETCH: the known-good listing stays beside the error.
  let store = applyDirReply(beginDirFetch(emptyDirStore(), "x"), "x", {
    entries: [{ name: "keep.txt", kind: "file" }],
  });
  store = applyDirReply(beginDirFetch(store, "x"), "x", {
    entries: [],
    error: "requests are arriving too fast — retry shortly",
  });
  const st = store.get("x")!;
  assert.equal(st.phase, "error");
  assert.match(String(st.phase === "error" && st.error), /too fast/);
  assert.deepEqual(shownListing(st)?.entries, [{ name: "keep.txt", kind: "file" }]);
});

test("a new fetch clears a previous error — the new reply decides", () => {
  let store = applyDirReply(beginDirFetch(emptyDirStore(), "x"), "x", {
    entries: [],
    error: "nope",
  });
  store = beginDirFetch(store, "x");
  assert.deepEqual(store.get("x"), { phase: "loading" });
});

test("prune drops cached dirs not kept — the root always survives", () => {
  let store = emptyDirStore();
  for (const p of ["", "src", "src/deep", "web"]) {
    store = applyDirReply(beginDirFetch(store, p), p, { entries: [] });
  }
  const pruned = pruneDirStore(store, new Set(["src"]));
  assert.deepEqual([...pruned.keys()].sort(), ["", "src"]);
});

test("transitions never mutate the input store", () => {
  const before = applyDirReply(beginDirFetch(emptyDirStore(), ""), "", {
    entries: [{ name: "a", kind: "dir" }],
  });
  const snapshot = before.get("")!;
  beginDirFetch(before, "");
  applyDirReply(before, "", { entries: [] });
  pruneDirStore(before, new Set());
  assert.equal(before.get(""), snapshot, "input map is untouched");
  assert.equal(before.size, 1);
});

test("childDirPaths: only dirs qualify (symlinks are leaves), paths nest under the parent", () => {
  const entries = [
    { name: "deep", kind: "dir" as const },
    { name: "app.ts", kind: "file" as const },
    { name: "link", kind: "symlink" as const },
  ];
  assert.deepEqual(childDirPaths("", entries), ["deep"]);
  assert.deepEqual(childDirPaths("src", entries), ["src/deep"]);
});

test("bellRefreshDelay: immediate when the gap has passed, trailing remainder inside it (W.2)", () => {
  assert.equal(bellRefreshDelay(10_000, 0, 1_000), 0, "no prior refresh → run now");
  assert.equal(bellRefreshDelay(10_000, 9_000, 1_000), 0, "gap exactly elapsed → run now");
  assert.equal(bellRefreshDelay(10_000, 9_400, 1_000), 400, "inside the gap → wait the remainder");
  assert.equal(bellRefreshDelay(10_000, 10_000, 1_000), 1_000, "same-instant repeat → full gap");
});
