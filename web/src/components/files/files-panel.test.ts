import { test } from "node:test";
import assert from "node:assert/strict";
import { rootNameOf } from "../../files-tree";
import { diffTooLarge } from "./FileView";
import { isCurrentReply, isRetryableFileError } from "./use-file-view";
import {
  closeFilePane,
  emptyFilePaneState,
  moveFilePane,
  openFilePane,
} from "./file-pane-state";

// E.3 pure logic: the stale-reply gate and the client-side diff-size guard.

test("isCurrentReply: only the awaited id is accepted", () => {
  assert.equal(isCurrentReply("fsl-abc", "fsl-abc"), true);
  assert.equal(isCurrentReply("fsl-abc", "fsl-xyz"), false, "a superseded reply is dropped");
  assert.equal(isCurrentReply(null, "fsl-abc"), false, "nothing awaited → drop");
});

test("PN.2 file backpressure retries only the daemon's typed transient refusals", () => {
  assert.equal(isRetryableFileError("requests are arriving too fast — retry shortly"), true);
  assert.equal(isRetryableFileError("a git query is already running — retry shortly"), true);
  assert.equal(isRetryableFileError("file does not exist"), false);
  assert.equal(isRetryableFileError(undefined), false);
});

test("rootNameOf: the root row carries the folder's name, not the path", () => {
  assert.equal(rootNameOf("~/Projects/mirafold/mirafold"), "mirafold");
  assert.equal(rootNameOf("~/Projects/x/"), "x", "trailing slash is ignored");
  assert.equal(rootNameOf("C:\\Users\\Kyle\\Projects\\mirafold"), "mirafold");
  assert.equal(rootNameOf("C:\\Users\\Kyle\\Projects\\x\\"), "x", "Windows trailing slash is ignored");
  assert.equal(rootNameOf("~\\Projects\\mirafold"), "mirafold", "a tildified Windows path stays legible");
  assert.equal(rootNameOf("~"), "~", "home itself keeps the tilde");
  assert.equal(rootNameOf("/"), "/", "filesystem root stays legible");
  assert.equal(rootNameOf("C:\\"), "C:\\", "Windows filesystem root stays legible");
  assert.equal(rootNameOf("/tmp/folder\\name"), "folder\\name", "POSIX backslashes stay filename data");
  assert.equal(rootNameOf(undefined), "files", "no label yet → a neutral name");
});

test("diffTooLarge: small diffs pass, huge ones are guarded", () => {
  assert.equal(diffTooLarge("a\nb\nc", "a\nB\nc"), false);
  assert.equal(diffTooLarge("", "brand new file\n"), false, "added file (empty before)");
  assert.equal(diffTooLarge("deleted\n", ""), false, "deleted file (empty after)");
  const huge = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(diffTooLarge(huge, huge + "\nmore"), true, "3000×3001 > 4M cells");
});

test("PN.2 pane tabs deduplicate paths, refresh on reopen, and close to a neighbor", () => {
  let state = emptyFilePaneState();
  state = openFilePane(state, "package.json", undefined, 1);
  state = openFilePane(state, "README.md", "M", 2);
  assert.deepEqual(
    state.tabs.map(({ id, path, requestVersion }) => ({ id, path, requestVersion })),
    [
      { id: 1, path: "package.json", requestVersion: 0 },
      { id: 2, path: "README.md", requestVersion: 0 },
    ],
  );
  assert.equal(state.activeId, 2);

  state = openFilePane(state, "package.json", "M", 99);
  assert.equal(state.tabs.length, 2, "reopening a path created a duplicate tab");
  assert.equal(state.activeId, 1);
  assert.equal(state.tabs[0].status, "M");
  assert.equal(state.tabs[0].requestVersion, 1, "reopening did not request a fresh view");

  state = closeFilePane(state, 1);
  assert.equal(state.activeId, 2, "closing the first active tab did not choose its right neighbor");
  state = closeFilePane(state, 2);
  assert.deepEqual(state, emptyFilePaneState());
});

test("PN.2 tab arrow destinations wrap and Home/End select the endpoints", () => {
  let state = emptyFilePaneState();
  state = openFilePane(state, "a.ts", undefined, 1);
  state = openFilePane(state, "b.ts", undefined, 2);
  state = openFilePane(state, "c.ts", undefined, 3);
  assert.equal(moveFilePane(state, 1, "previous"), 3);
  assert.equal(moveFilePane(state, 3, "next"), 1);
  assert.equal(moveFilePane(state, 2, "first"), 1);
  assert.equal(moveFilePane(state, 2, "last"), 3);
});
