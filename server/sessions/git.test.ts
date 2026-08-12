import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanRelPath,
  decorateGitDir,
  discoverNestedRepoRoots,
  findRepoRoot,
  gitChanges,
  gitTree,
  parseStatusIgnoredZ,
  parseStatusZ,
  workspaceChanges,
} from "./git";

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
  // The host running the suite may itself have an ancestor marker (for
  // example a sandbox-owned /tmp/.git). This probe keeps the fixture's
  // filesystem real while making its declared root the test boundary.
  const fixtureExists = (candidate: string) =>
    candidate.startsWith(`${base}${path.sep}`) && existsSync(candidate);
  mkdirSync(path.join(base, "outer", ".git"), { recursive: true });
  mkdirSync(path.join(base, "outer", "src", "deep"), { recursive: true });
  mkdirSync(path.join(base, "outer", "inner", ".git"), { recursive: true });
  mkdirSync(path.join(base, "outer", "inner", "lib"), { recursive: true });
  mkdirSync(path.join(base, "plain", "sub"), { recursive: true });
  const outer = path.join(base, "outer");
  const inner = path.join(outer, "inner");
  assert.equal(findRepoRoot(outer, fixtureExists), outer);
  assert.equal(findRepoRoot(path.join(outer, "src", "deep"), fixtureExists), outer);
  assert.equal(
    findRepoRoot(inner, fixtureExists),
    inner,
    "a repo nested in a repo resolves to ITS OWN root",
  );
  assert.equal(findRepoRoot(path.join(inner, "lib"), fixtureExists), inner);
  assert.equal(findRepoRoot(path.join(base, "plain", "sub"), fixtureExists), null);
  // A .git FILE (worktree/submodule form) marks a boundary too.
  mkdirSync(path.join(base, "worktree"));
  writeFileSync(path.join(base, "worktree", ".git"), "gitdir: /elsewhere\n");
  assert.equal(
    findRepoRoot(path.join(base, "worktree"), fixtureExists),
    path.join(base, "worktree"),
  );
});

test("gitTree: path-byte admission counts UTF-8 bytes, not JavaScript characters", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gittree-bytes-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const name = "é.txt";
  writeFileSync(path.join(root, name), "x");
  assert.ok(Buffer.byteLength(name, "utf8") > name.length, "fixture distinguishes bytes from characters");
  const result = await gitTree(root, { maxPathBytes: name.length });
  assert.ok("entries" in result);
  if (!("entries" in result)) return;
  assert.deepEqual(result.entries, [], "a path larger than the byte budget is never admitted");
  assert.equal(result.truncated, true);
});

const initRepo = (root: string): void => {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: root });
};

const commitAll = (root: string, message = "fixture"): void => {
  execFileSync("git", ["add", "--all"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Mirafold Test", "-c", "user.email=test@invalid", "commit", "--quiet", "-m", message],
    { cwd: root },
  );
};

test("gitChanges: returns only changed files, including expanded untracked files and deletions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gitchanges-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  initRepo(root);
  writeFileSync(path.join(root, "changed.txt"), "before\n");
  writeFileSync(path.join(root, "deleted.txt"), "before\n");
  writeFileSync(path.join(root, "clean.txt"), "same\n");
  commitAll(root);

  writeFileSync(path.join(root, "changed.txt"), "after\n");
  rmSync(path.join(root, "deleted.txt"));
  mkdirSync(path.join(root, "new", "deep"), { recursive: true });
  writeFileSync(path.join(root, "new", "deep", "untracked.txt"), "new\n");

  const result = await gitChanges(root);
  assert.ok("entries" in result);
  if (!("entries" in result)) return;
  assert.deepEqual(result.entries, [
    { path: "changed.txt", status: "M" },
    { path: "deleted.txt", status: "D" },
    { path: "new/deep/untracked.txt", status: "U" },
  ]);
  assert.equal(result.truncated, false);
});

test("gitChanges: a subdirectory session excludes changes above it and returns scope-relative paths", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gitchanges-scope-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  initRepo(root);
  mkdirSync(path.join(root, "app"));
  writeFileSync(path.join(root, "app", "inside.txt"), "before\n");
  writeFileSync(path.join(root, "outside.txt"), "before\n");
  commitAll(root);
  writeFileSync(path.join(root, "app", "inside.txt"), "after\n");
  writeFileSync(path.join(root, "outside.txt"), "after\n");

  const result = await gitChanges(path.join(root, "app"));
  assert.ok("entries" in result);
  if (!("entries" in result)) return;
  assert.deepEqual(result.entries, [{ path: "inside.txt", status: "M" }]);
});

test("gitChanges: entry and UTF-8 path-byte caps are explicit truncation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gitchanges-caps-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  initRepo(root);
  writeFileSync(path.join(root, "a.txt"), "a\n");
  writeFileSync(path.join(root, "é.txt"), "e\n");

  const countCapped = await gitChanges(root, { maxEntries: 1 });
  assert.ok("entries" in countCapped);
  if ("entries" in countCapped) {
    assert.equal(countCapped.entries.length, 1);
    assert.equal(countCapped.truncated, true);
  }
  const byteCapped = await gitChanges(root, { maxPathBytes: "é.txt".length });
  assert.ok("entries" in byteCapped);
  if ("entries" in byteCapped) {
    assert.ok(!byteCapped.entries.some((entry) => entry.path === "é.txt"));
    assert.equal(byteCapped.truncated, true);
  }
});

test("discoverNestedRepoRoots: finds sibling repos, stops inside each, skips node_modules, and reports caps", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gitdiscover-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const linkedTarget = mkdtempSync(path.join(os.tmpdir(), "gitdiscover-linked-"));
  after(() => rmSync(linkedTarget, { recursive: true, force: true }));
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "group", "beta");
  initRepo(alpha);
  initRepo(beta);
  initRepo(path.join(alpha, "nested-but-owned-by-alpha"));
  initRepo(path.join(root, "node_modules", "ignored-repo"));
  initRepo(linkedTarget);
  if (process.platform !== "win32") {
    symlinkSync(linkedTarget, path.join(root, "linked-repo"), "dir");
  }

  assert.deepEqual(discoverNestedRepoRoots(root), {
    roots: [alpha, beta].sort(),
    truncated: false,
  });
  const repoCapped = discoverNestedRepoRoots(root, { maxRepos: 1 });
  assert.ok("roots" in repoCapped);
  if ("roots" in repoCapped) {
    assert.equal(repoCapped.roots.length, 1);
    assert.equal(repoCapped.truncated, true);
  }
  assert.deepEqual(discoverNestedRepoRoots(root, { maxNodes: 0 }), {
    roots: [],
    truncated: true,
  });
});

test("workspaceChanges: a parent workspace groups nested repos and maps entries to session-relative paths", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workspacechanges-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "group", "beta");
  initRepo(alpha);
  initRepo(beta);
  writeFileSync(path.join(alpha, "one.txt"), "one\n");
  writeFileSync(path.join(beta, "two.txt"), "two\n");

  const result = await workspaceChanges(root);
  assert.ok("repos" in result);
  if (!("repos" in result)) return;
  assert.deepEqual(result, {
    repos: [
      { root: "alpha", entries: [{ path: "alpha/one.txt", status: "U" }] },
      { root: "group/beta", entries: [{ path: "group/beta/two.txt", status: "U" }] },
    ],
    truncated: false,
  });

  const capped = await workspaceChanges(root, { maxEntries: 1 });
  assert.ok("repos" in capped);
  if ("repos" in capped) {
    assert.equal(capped.repos.flatMap((repo) => repo.entries).length, 1);
    assert.equal(capped.truncated, true);
  }
  const labelCapped = await workspaceChanges(root, { maxPathBytes: 4 });
  assert.deepEqual(labelCapped, { repos: [], truncated: true }, "repository labels spend the path-byte budget too");
});
