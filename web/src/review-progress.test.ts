import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyReviewProgress,
  fileIsReviewed,
  invalidateReviewProgress,
  nextUnreviewedIndex,
  pruneReviewProgress,
  reviewedFileCount,
  setFileReviewed,
} from "./review-progress";

const items = ["a.ts", "src/b.ts", "c.ts"].map((path) => ({ path }));

test("review progress: a mark belongs to one exact file revision and can be removed", () => {
  const marked = setFileReviewed(emptyReviewProgress(), "a.ts", "rev-1", true);
  assert.equal(fileIsReviewed(marked, "a.ts", "rev-1"), true);
  assert.equal(fileIsReviewed(marked, "a.ts", "rev-2"), false);
  assert.equal(fileIsReviewed(marked, "other.ts", "rev-1"), false);
  assert.equal(setFileReviewed(marked, "a.ts", "rev-1", false).size, 0);
});

test("review progress: an exact disk hint invalidates only the touched file", () => {
  let progress = emptyReviewProgress();
  for (const item of items) progress = setFileReviewed(progress, item.path, `rev:${item.path}`, true);
  const result = invalidateReviewProgress(progress, { paths: ["src/b.ts"] });
  assert.deepEqual(result.invalidated, ["src/b.ts"]);
  assert.equal(result.progress.has("a.ts"), true);
  assert.equal(result.progress.has("src/b.ts"), false);
  assert.equal(result.progress.has("c.ts"), true);
});

test("review progress: directory hints are scoped; HEAD or incomplete hints invalidate all", () => {
  let progress = emptyReviewProgress();
  for (const item of items) progress = setFileReviewed(progress, item.path, `rev:${item.path}`, true);
  const directory = invalidateReviewProgress(progress, { paths: ["src"] });
  assert.deepEqual(directory.invalidated, ["src/b.ts"]);
  assert.equal(invalidateReviewProgress(progress, { paths: [".git/index"] }).invalidated.length, 0);
  assert.equal(invalidateReviewProgress(progress, { paths: [".git/HEAD"] }).invalidated.length, 3);
  assert.equal(invalidateReviewProgress(progress, { paths: ["repo/.git/refs/heads/main"] }).invalidated.length, 3);
  assert.equal(invalidateReviewProgress(progress, { paths: ["a.ts"], truncated: true }).invalidated.length, 3);
  assert.equal(invalidateReviewProgress(progress, {}).invalidated.length, 3);
});

test("review progress: pruning prevents a vanished file from returning reviewed", () => {
  let progress = setFileReviewed(emptyReviewProgress(), "a.ts", "rev-a", true);
  progress = setFileReviewed(progress, "gone.ts", "rev-gone", true);
  const pruned = pruneReviewProgress(progress, items);
  assert.deepEqual([...pruned.keys()], ["a.ts"]);
  assert.equal(reviewedFileCount(pruned, items), 1);
});

test("next unreviewed: skips reviewed files, wraps once, and never targets the current file", () => {
  let progress = setFileReviewed(emptyReviewProgress(), "src/b.ts", "rev-b", true);
  assert.equal(nextUnreviewedIndex(items, progress, "a.ts"), 2);
  assert.equal(nextUnreviewedIndex(items, progress, "c.ts"), 0);
  progress = setFileReviewed(progress, "c.ts", "rev-c", true);
  assert.equal(nextUnreviewedIndex(items, progress, "a.ts"), -1, "the current unreviewed file is not a move");
  assert.equal(nextUnreviewedIndex(items, progress, undefined), 0);
});
