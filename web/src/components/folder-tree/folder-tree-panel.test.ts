import { test } from "node:test";
import assert from "node:assert/strict";
import { rootNameOf } from "../../workspace/folder-tree";
import { diffTooLarge } from "./FileView";
import { isCurrentReply } from "./use-file-view";

// E.3 pure logic: the stale-reply gate and the client-side diff-size guard.

test("isCurrentReply: only the awaited id is accepted", () => {
  assert.equal(isCurrentReply("fsl-abc", "fsl-abc"), true);
  assert.equal(isCurrentReply("fsl-abc", "fsl-xyz"), false, "a superseded reply is dropped");
  assert.equal(isCurrentReply(null, "fsl-abc"), false, "nothing awaited → drop");
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
