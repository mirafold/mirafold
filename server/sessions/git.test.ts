import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanRelPath, decorateGitDir, findRepoRoot, parseStatusIgnoredZ, parseStatusZ } from "./git";

// E.2's pure parsing pins: the -z rename two-field trap, status collapsing,
// and the textual path containment that guards `git show`. E2.3 adds the
// per-repo layer's pins: the --ignored parse, the directory decoration
// rules, and nearest-.git repo discovery on real temp dirs.

test("parseStatusZ: plain records collapse to single chars", () => {
  const { files } = parseStatusZ("M  a.txt\0?? new.txt\0 D gone.txt\0A  staged.txt\0 M work.txt\0");
  assert.equal(files.get("a.txt"), "M");
  assert.equal(files.get("new.txt"), "U");
  assert.equal(files.get("gone.txt"), "D");
  assert.equal(files.get("staged.txt"), "A");
  assert.equal(files.get("work.txt"), "M");
});

test("parseStatusZ: a rename record is TWO fields — later records stay aligned", () => {
  // R: `XY to\0from\0`. A naive one-field split would read `old.txt` as a
  // record and misparse everything after it.
  const { files } = parseStatusZ("R  new-name.txt\0old-name.txt\0M  after-the-rename.txt\0");
  assert.equal(files.get("new-name.txt"), "A");
  assert.equal(files.get("old-name.txt"), "D");
  assert.equal(files.get("after-the-rename.txt"), "M", "alignment survives the rename record");
});

test("parseStatusZ: a copy's source is NOT marked deleted", () => {
  const { files } = parseStatusZ("C  copy.txt\0source.txt\0");
  assert.equal(files.get("copy.txt"), "A");
  assert.equal(files.get("source.txt"), undefined, "the copy source still exists unchanged");
});

test("parseStatusZ: trailing empty field and junk are ignored", () => {
  const { files } = parseStatusZ("M  a.txt\0\0x\0");
  assert.equal(files.size, 1);
});

test("parseStatusZ: a wholly-untracked dir is a PREFIX, not a phantom file (2026-07-28)", () => {
  // Default untracked-files=normal collapses the dir to one `?? dir/` record;
  // treating it as a file shipped a trailing-slash entry with status U while
  // the real files inside (listed by ls-files --others) carried none.
  const { files, untrackedDirs } = parseStatusZ("?? newdir/\0?? loose.txt\0");
  assert.equal(files.get("loose.txt"), "U");
  assert.ok(!files.has("newdir/"), "the collapse is not a file status");
  assert.deepEqual([...untrackedDirs], ["newdir"]);
});

test("cleanRelPath: accepts plain relative paths, normalizes ./", () => {
  assert.equal(cleanRelPath("src/app.ts"), "src/app.ts");
  assert.equal(cleanRelPath("./src/app.ts"), "src/app.ts");
  assert.equal(cleanRelPath("a"), "a");
});

test("cleanRelPath: rejects traversal, absolute, empty, backslash, NUL, oversized", () => {
  for (const bad of [
    "../loot",
    "a/../b",
    "..",
    "/etc/passwd",
    "",
    "a//b",
    "a\\b",
    "a\0b",
    ".",
    "x".repeat(5_000),
  ]) {
    assert.equal(cleanRelPath(bad), null, JSON.stringify(bad));
  }
});

// --- E2.3: the per-repo layer ---

test("parseStatusIgnoredZ: files, dir collapses, ignored, and the rename trap land in the right buckets", () => {
  const st = parseStatusIgnoredZ(
    "M  a.txt\0 D gone.txt\0?? loose.txt\0?? newdir/\0!! dist/\0!! secret.log\0" +
      "R  new-name.txt\0old-name.txt\0M  after-the-rename.txt\0",
  );
  assert.equal(st.files.get("a.txt"), "M");
  assert.equal(st.files.get("gone.txt"), "D");
  assert.equal(st.files.get("loose.txt"), "U");
  assert.ok(st.untrackedDirs.has("newdir"), "a `?? dir/` collapse is a dir, not a file status");
  assert.ok(!st.files.has("newdir/"), "the collapse never lands in the file map");
  assert.ok(st.ignored.has("dist"), "an ignored dir is stored without its trailing slash");
  assert.ok(st.ignored.has("secret.log"));
  assert.ok(!st.files.has("dist/"), "`!!` never collapses to M");
  assert.equal(st.files.get("new-name.txt"), "A");
  assert.equal(st.files.get("old-name.txt"), "D");
  assert.equal(st.files.get("after-the-rename.txt"), "M", "alignment survives the rename record");
});

test("decorateGitDir: ignored entries drop, statuses attach, deleted children merge in", () => {
  const st = parseStatusIgnoredZ(
    "M  changed.txt\0 D doomed.txt\0?? newdir/\0!! dist/\0!! secret.log\0",
  );
  const out = decorateGitDir(
    [
      { name: "changed.txt", kind: "file" },
      { name: "kept.txt", kind: "file" },
      { name: "secret.log", kind: "file" },
      { name: "dist", kind: "dir" },
      { name: "newdir", kind: "dir" },
    ],
    "",
    st,
  );
  const byName = new Map(out.map((e) => [e.name, e]));
  assert.ok(!byName.has("dist"), "an ignored dir is dropped from the listing");
  assert.ok(!byName.has("secret.log"), "an ignored file is dropped from the listing");
  assert.equal(byName.get("changed.txt")?.status, "M");
  assert.equal(byName.get("kept.txt")?.status, undefined, "a clean tracked file carries no status");
  assert.equal(byName.get("newdir")?.status, "U", "a wholly-untracked dir shows U");
  assert.deepEqual(
    byName.get("doomed.txt"),
    { name: "doomed.txt", kind: "file", status: "D" },
    "a deleted file exists in status but not on disk — merged in, visible",
  );
});

test("decorateGitDir: children of a collapsed untracked dir inherit U — porcelain gave them no record of their own", () => {
  const st = parseStatusIgnoredZ("?? newdir/\0");
  const out = decorateGitDir(
    [
      { name: "fresh.txt", kind: "file" },
      { name: "deeper", kind: "dir" },
    ],
    "newdir",
    st,
  );
  assert.deepEqual(out, [
    { name: "fresh.txt", kind: "file", status: "U" },
    { name: "deeper", kind: "dir", status: "U" },
  ]);
});

test("decorateGitDir: a nested dir keys repo-root-relative — same names, different dir, different verdicts", () => {
  const st = parseStatusIgnoredZ("M  sub/changed.txt\0!! sub/dist/\0");
  const out = decorateGitDir(
    [
      { name: "changed.txt", kind: "file" },
      { name: "dist", kind: "dir" },
    ],
    "sub",
    st,
  );
  assert.deepEqual(out, [{ name: "changed.txt", kind: "file", status: "M" }]);
  // And at the ROOT, the same raw names match nothing — sub/'s records don't leak up.
  const root = decorateGitDir(
    [
      { name: "changed.txt", kind: "file" },
      { name: "dist", kind: "dir" },
    ],
    "",
    st,
  );
  assert.deepEqual(root, [
    { name: "changed.txt", kind: "file" },
    { name: "dist", kind: "dir" },
  ]);
});

test("findRepoRoot: nearest .git wins; no .git anywhere is null", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "gitfind-"));
  after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(path.join(base, "outer", ".git"), { recursive: true });
  mkdirSync(path.join(base, "outer", "src", "deep"), { recursive: true });
  mkdirSync(path.join(base, "outer", "inner", ".git"), { recursive: true });
  mkdirSync(path.join(base, "outer", "inner", "lib"), { recursive: true });
  mkdirSync(path.join(base, "plain", "sub"), { recursive: true });
  const outer = path.join(base, "outer");
  const inner = path.join(outer, "inner");
  assert.equal(findRepoRoot(outer), outer);
  assert.equal(findRepoRoot(path.join(outer, "src", "deep")), outer);
  assert.equal(findRepoRoot(inner), inner, "a repo nested in a repo resolves to ITS OWN root");
  assert.equal(findRepoRoot(path.join(inner, "lib")), inner);
  assert.equal(findRepoRoot(path.join(base, "plain", "sub")), null);
  // A .git FILE (worktree/submodule form) marks a boundary too.
  mkdirSync(path.join(base, "worktree"));
  writeFileSync(path.join(base, "worktree", ".git"), "gitdir: /elsewhere\n");
  assert.equal(findRepoRoot(path.join(base, "worktree")), path.join(base, "worktree"));
});
