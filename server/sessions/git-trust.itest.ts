import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureGit as git } from "../testing/itest-harness";
import { gitShowHead, gitTree, invalidateRepoStatusCache, repoStatus } from "./git";
import { repoTrust } from "./git-trust";

// The regression pin for the 2026-07-26 audit finding: a repository can ask
// git — through settings in its own `.git/config` — to RUN a program during
// ordinary read-only commands, and the daemon runs those commands
// automatically when a Files panel opens. These tests plant real programs in
// all three proven settings and assert they never execute, by checking
// whether the program left its mark on disk. Each program writes a marker
// file; a marker's existence IS the vulnerability reproducing.

let repo: string;
let bin: string;
let trustPath: string;

const marker = (name: string) => path.join(bin, `${name}.fired`);
const fired = (name: string) => existsSync(marker(name));

/** A program that records that it ran. `passthrough` keeps content filters
 *  well-behaved (stdin→stdout) so git's own behavior stays normal. */
function plantProgram(name: string, passthrough: boolean): string {
  const p = path.join(bin, `${name}.sh`);
  writeFileSync(p, `#!/bin/sh\ntouch ${JSON.stringify(marker(name))}\n${passthrough ? "cat" : "exit 1"}\n`);
  chmodSync(p, 0o755);
  return p;
}

const clearMarkers = () => {
  for (const n of ["fsmonitor", "clean", "process"]) rmSync(marker(n), { force: true });
};

/** Force git to actually read file content: same byte count as the committed
 *  version with a stale timestamp, so the stat shortcut can't decide and the
 *  content filter must run (this is what makes the filter vector reachable). */
const forceContentRead = () => {
  const f = path.join(repo, "f.txt");
  writeFileSync(f, "originaX\n");
  utimesSync(f, new Date(1000), new Date(1000));
};

before(() => {
  bin = mkdtempSync(path.join(os.tmpdir(), "trust-bin-"));
  trustPath = path.join(bin, "trusted-repos.json");
  process.env.MIRAFOLD_TRUST_FILE = trustPath;

  repo = mkdtempSync(path.join(os.tmpdir(), "trust-repo-"));
  git(repo, "init", "-q");
  writeFileSync(path.join(repo, ".gitattributes"), "* filter=evil\n.gitattributes -filter\n");
  writeFileSync(path.join(repo, "f.txt"), "original\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "c1");

  // All three proven vectors, set repo-locally — exactly what an unpacked
  // hostile archive would carry.
  git(repo, "config", "core.fsmonitor", plantProgram("fsmonitor", false));
  git(repo, "config", "filter.evil.clean", plantProgram("clean", true));
  git(repo, "config", "filter.evil.process", plantProgram("process", false));
});
after(() => {
  delete process.env.MIRAFOLD_TRUST_FILE;
  rmSync(repo, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

test("a hostile repo's programs never run across every git call the daemon makes", async () => {
  invalidateRepoStatusCache();
  clearMarkers();
  forceContentRead();

  const status = await repoStatus(repo);
  assert.ok("files" in status, "the listing still gets real git data");
  assert.equal(status.files.get("f.txt"), "M", "and that data is correct");

  await gitTree(repo);
  await gitShowHead(repo, "f.txt");

  for (const vector of ["fsmonitor", "clean", "process"]) {
    assert.equal(fired(vector), false, `${vector} program EXECUTED — the repo ran code`);
  }
});

test("the refusal is reported honestly — the settings are named, not hidden", async () => {
  invalidateRepoStatusCache();
  const trust = await repoTrust(repo);
  assert.equal(trust.allowed, false);
  assert.deepEqual(
    trust.risky.map((r) => r.key).sort(),
    ["core.fsmonitor", "filter.evil.clean", "filter.evil.process"],
  );
});

test("a setting hidden in an included config file is still caught", async () => {
  const hidden = path.join(bin, "hidden.cfg");
  const sneaky = mkdtempSync(path.join(os.tmpdir(), "trust-sneaky-"));
  try {
    git(sneaky, "init", "-q");
    writeFileSync(hidden, `[core]\n\tfsmonitor = ${plantProgram("fsmonitor", false)}\n`);
    git(sneaky, "config", "include.path", hidden);
    invalidateRepoStatusCache();
    const trust = await repoTrust(sneaky);
    assert.deepEqual(
      trust.risky.map((r) => r.key),
      ["core.fsmonitor"],
      "a textual read of .git/config would have missed this",
    );
  } finally {
    rmSync(sneaky, { recursive: true, force: true });
  }
});

test("the user's allow list lets a repo's own programs run again", async () => {
  writeFileSync(trustPath, JSON.stringify({ repos: [repo] }));
  invalidateRepoStatusCache();
  clearMarkers();
  forceContentRead();

  const trust = await repoTrust(repo);
  assert.equal(trust.allowed, true);
  assert.deepEqual(trust.disableArgs, [], "an allowed repo is not neutralized");

  await repoStatus(repo);
  assert.equal(fired("fsmonitor"), true, "the allowed repo's own program runs — terminal parity");

  rmSync(trustPath, { force: true });
  invalidateRepoStatusCache();
  clearMarkers();
  forceContentRead();
  await repoStatus(repo);
  assert.equal(fired("fsmonitor"), false, "removing the allow restores the refusal");
});

test("a malformed allow list means nothing is allowed, never a crash", async () => {
  writeFileSync(trustPath, "{ this is not json");
  invalidateRepoStatusCache();
  const trust = await repoTrust(repo);
  assert.equal(trust.allowed, false);
  assert.ok(trust.disableArgs.length > 0, "still neutralized");
  rmSync(trustPath, { force: true });
});

test("the daemon's own trust scan reads config without running anything", async () => {
  invalidateRepoStatusCache();
  clearMarkers();
  await repoTrust(repo);
  for (const vector of ["fsmonitor", "clean", "process"]) {
    assert.equal(fired(vector), false, `the scan itself ran the ${vector} program`);
  }
  assert.ok(readFileSync(path.join(repo, ".git", "config"), "utf8").includes("fsmonitor"));
});
