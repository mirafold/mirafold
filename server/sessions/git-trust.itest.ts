import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureGit as git } from "../testing/itest-harness";
import { gitChanges, gitShowHead, gitTree, invalidateRepoStatusCache, repoStatus, workspaceChanges } from "./git";
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
  for (const n of ["fsmonitor", "clean", "process", "eq", "sub", "padded"]) rmSync(marker(n), { force: true });
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

test("machine-level config is never flagged — only what the repo brought", async () => {
  // CI's runners ship git-lfs preconfigured system-wide, which is exactly a
  // real dev machine after `git lfs install`: filter.lfs.clean/process live in
  // the merged config of EVERY repo. The scan must not report them — flagging
  // the user's own machine settings would refuse every repo they browse.
  const sysConfig = path.join(bin, "system-gitconfig");
  writeFileSync(
    sysConfig,
    '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tprocess = git-lfs filter-process\n[core]\n\tfsmonitor = /usr/bin/true\n',
  );
  const clean = mkdtempSync(path.join(os.tmpdir(), "trust-clean-"));
  process.env.GIT_CONFIG_SYSTEM = sysConfig;
  try {
    git(clean, "init", "-q");
    invalidateRepoStatusCache();
    const trust = await repoTrust(clean);
    assert.deepEqual(trust.risky, [], "machine-level settings reported as the repo's own");
    assert.deepEqual(trust.disableEnv, {}, "and nothing neutralized — terminal parity");
  } finally {
    delete process.env.GIT_CONFIG_SYSTEM;
    rmSync(clean, { recursive: true, force: true });
    rmSync(sysConfig, { force: true });
  }
});

test("the user's allow list lets a repo's own programs run again", async () => {
  writeFileSync(trustPath, JSON.stringify({ repos: [repo] }));
  invalidateRepoStatusCache();
  clearMarkers();
  forceContentRead();

  const trust = await repoTrust(repo);
  assert.equal(trust.allowed, true);
  assert.deepEqual(trust.disableEnv, {}, "an allowed repo is not neutralized");

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
  assert.ok(Object.keys(trust.disableEnv).length > 0, "still neutralized");
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

// ── AUDIT 2026-08-26: three ways the guard above was bypassed, each proven
// with a marker program before the fix. The rule the fixes state: the
// neutralization is exact whatever the driver is named, no git the daemon
// runs may spawn another git the scan did not cover, and a scan that fails
// is a refusal, never a pass.

test("a `=` in a filter driver's name does not split the neutralization (env pairs, not -c)", async () => {
  const r = mkdtempSync(path.join(os.tmpdir(), "trust-eq-"));
  try {
    git(r, "init", "-q");
    writeFileSync(path.join(r, ".gitattributes"), "* filter=ev=il\n.gitattributes -filter\n");
    writeFileSync(path.join(r, "f.txt"), "original\n");
    git(r, "add", "-A");
    git(r, "commit", "-qm", "c1");
    git(r, "config", "filter.ev=il.clean", plantProgram("eq", true));
    writeFileSync(path.join(r, "f.txt"), "originaX\n");
    utimesSync(path.join(r, "f.txt"), new Date(1000), new Date(1000));
    invalidateRepoStatusCache();
    clearMarkers();
    const trust = await repoTrust(r);
    assert.deepEqual(trust.risky.map((x) => x.key), ["filter.ev=il.clean"]);
    await repoStatus(r);
    await gitChanges(r);
    await workspaceChanges(r);
    assert.equal(fired("eq"), false, "the `=`-named driver EXECUTED");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a submodule's own config never runs: status does not recurse into it", async () => {
  const outer = mkdtempSync(path.join(os.tmpdir(), "trust-super-"));
  const inner = mkdtempSync(path.join(os.tmpdir(), "trust-sub-"));
  try {
    git(inner, "init", "-q");
    writeFileSync(path.join(inner, "s.txt"), "s\n");
    git(inner, "add", "-A");
    git(inner, "commit", "-qm", "s1");
    git(outer, "init", "-q");
    writeFileSync(path.join(outer, "o.txt"), "o\n");
    git(outer, "add", "-A");
    git(outer, "commit", "-qm", "o1");
    git(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub");
    git(outer, "commit", "-qm", "add sub");
    // The archive's payload: the SUBMODULE's config names a program. The
    // superproject's own config is clean, so the scan sees nothing risky.
    git(path.join(outer, "sub"), "config", "core.fsmonitor", plantProgram("sub", false));
    writeFileSync(path.join(outer, "sub", "s.txt"), "dirty\n");
    invalidateRepoStatusCache();
    clearMarkers();
    const trust = await repoTrust(outer);
    assert.deepEqual(trust.risky, [], "the superproject itself is clean");
    const status = await repoStatus(outer);
    assert.ok("files" in status);
    await gitChanges(outer);
    await workspaceChanges(outer);
    assert.equal(fired("sub"), false, "the submodule's program EXECUTED via status recursion");
  } finally {
    rmSync(outer, { recursive: true, force: true });
    rmSync(inner, { recursive: true, force: true });
  }
});

test("a config the scanner cannot read in full is refused, never treated as clean", async () => {
  const r = mkdtempSync(path.join(os.tmpdir(), "trust-padded-"));
  try {
    git(r, "init", "-q");
    writeFileSync(path.join(r, ".gitattributes"), "* filter=evil\n.gitattributes -filter\n");
    writeFileSync(path.join(r, "f.txt"), "original\n");
    git(r, "add", "-A");
    git(r, "commit", "-qm", "c1");
    git(r, "config", "filter.evil.clean", plantProgram("padded", true));
    // Pad the config past the scanner's 2 MB buffer with inert keys.
    let pad = "";
    for (let i = 0; i < 12_000; i++) pad += `[pad "k${i}"]\n\tv = ${"x".repeat(180)}\n`;
    writeFileSync(path.join(r, ".git", "config"), readFileSync(path.join(r, ".git", "config"), "utf8") + pad);
    writeFileSync(path.join(r, "f.txt"), "originaX\n");
    utimesSync(path.join(r, "f.txt"), new Date(1000), new Date(1000));
    invalidateRepoStatusCache();
    clearMarkers();
    const trust = await repoTrust(r);
    assert.equal(trust.unscannable, true, "an unreadable scan fails closed");
    const status = await repoStatus(r);
    assert.ok("notGit" in status, "git is refused for the repo, the listing degrades");
    await gitChanges(r);
    await workspaceChanges(r);
    assert.equal(fired("padded"), false, "the driver hidden behind the padding EXECUTED");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});
