import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDir } from "./fs-folder-tree";

test("lazy directory listing bounds its raw scan before reply capping", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-dir-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 8; i++) writeFileSync(path.join(root, `f-${i}.txt`), "x");

  const result = listDir(root, "", { maxEntries: 20, maxScanEntries: 3 });

  assert.ok("entries" in result);
  if (!("entries" in result)) return;
  assert.equal(result.entries.length, 3);
  assert.equal(result.truncated, true);
});
