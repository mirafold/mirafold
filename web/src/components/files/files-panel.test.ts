import { test } from "node:test";
import assert from "node:assert/strict";
import { isCurrentReply } from "./FilesPanel";
import { diffTooLarge } from "./FileView";

// E.3 pure logic: the stale-reply gate and the client-side diff-size guard.

test("isCurrentReply: only the awaited id is accepted", () => {
  assert.equal(isCurrentReply("fsl-abc", "fsl-abc"), true);
  assert.equal(isCurrentReply("fsl-abc", "fsl-xyz"), false, "a superseded reply is dropped");
  assert.equal(isCurrentReply(null, "fsl-abc"), false, "nothing awaited → drop");
});

test("diffTooLarge: small diffs pass, huge ones are guarded", () => {
  assert.equal(diffTooLarge("a\nb\nc", "a\nB\nc"), false);
  assert.equal(diffTooLarge("", "brand new file\n"), false, "added file (empty before)");
  assert.equal(diffTooLarge("deleted\n", ""), false, "deleted file (empty after)");
  const huge = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(diffTooLarge(huge, huge + "\nmore"), true, "3000×3001 > 4M cells");
});
