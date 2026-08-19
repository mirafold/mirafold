import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  contentRevision,
  diffContentRevision,
  readWorkspaceFile,
  reviewDiffRevision,
} from "./fs-explorer";

const roots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-fs-revision-"));
  roots.push(root);
  return root;
};

after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

test("CR.4 content revisions are stable equality tokens that change with exact bytes", () => {
  const first = contentRevision(Buffer.from("same bytes"));
  assert.equal(contentRevision(Buffer.from("same bytes")), first);
  assert.notEqual(contentRevision(Buffer.from("different bytes")), first);
  assert.match(first, /^revision:v1:[a-f0-9]{64}$/);
  assert.notEqual(
    diffContentRevision(Buffer.from("a\0b"), contentRevision(Buffer.from("c"))),
    diffContentRevision(Buffer.from("a"), contentRevision(Buffer.from("b\0c"))),
    "length framing keeps the two diff sides unambiguous",
  );
});

test("CR.4 revision reads cover text and binary bytes but remain opt-in", () => {
  const root = tempRoot();
  writeFileSync(path.join(root, "text.txt"), "first\n");
  writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));

  const ordinary = readWorkspaceFile(root, "text.txt");
  const text = readWorkspaceFile(root, "text.txt", { revision: true });
  const binary = readWorkspaceFile(root, "binary.bin", { revision: true });
  assert.ok("content" in ordinary && ordinary.revision === undefined);
  assert.ok("content" in text && text.revision);
  assert.ok("binary" in binary && binary.revision);

  writeFileSync(path.join(root, "text.txt"), "second\n");
  const changed = readWorkspaceFile(root, "text.txt", { revision: true });
  assert.ok("content" in text && "content" in changed);
  assert.notEqual(changed.revision, text.revision);
});

test("CR.4 revision reads stay bounded and decline to make an unverifiable claim", () => {
  const root = tempRoot();
  writeFileSync(path.join(root, "over-cap.txt"), "12345");
  const result = readWorkspaceFile(root, "over-cap.txt", {
    revision: true,
    revisionCapBytes: 4,
  });
  assert.ok("content" in result);
  assert.equal(result.content, "12345");
  assert.equal(result.revision, undefined);
  assert.equal(
    reviewDiffRevision(Buffer.from("12345"), contentRevision(Buffer.alloc(0)), 4),
    undefined,
    "an oversized HEAD side also withholds the combined revision",
  );
});
