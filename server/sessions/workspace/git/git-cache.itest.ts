import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureGit as git } from "../../../testing/itest-harness";
import { invalidateRepoStatusCache, repoStatus } from "./git";

// W.H2 against a real repo, with Date mocked for determinism: the status
// cache's TTL clock starts at SETTLE, not request. In flight, an entry is
// always fresh — a late caller coalesces onto the running call no matter
// how stale the request-time stamp would have been (the pre-fix backlog:
// git outruns the TTL → every new caller enqueues another child behind the
// slow one). Only Date is mocked; the git subprocess runs (and settles) in
// real time underneath.

let repo: string;

before(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "gitcache-"));
  git(repo, "init", "-q");
  writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c1");
  writeFileSync(path.join(repo, "tracked.txt"), "one\ntwo\n"); // an M to see
});
after(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("W.H2: in-flight coalesces past the TTL; the settled clock runs from arrival", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  invalidateRepoStatusCache();

  const p1 = repoStatus(repo);
  // 100 mocked seconds later — far past the 3s TTL — while the real git
  // child is still in flight: the entry must still coalesce.
  t.mock.timers.setTime(200_000);
  const p2 = repoStatus(repo);
  assert.equal(p2, p1, "an in-flight status must coalesce no matter how old the request");

  const r1 = await p1; // settles now → the TTL clock stamps at mocked 200_000
  assert.ok("files" in r1 && r1.files.get("tracked.txt") === "M", "the real repo answered");

  t.mock.timers.setTime(202_999); // inside the TTL measured from SETTLE
  assert.equal(repoStatus(repo), p1, "fresh-from-arrival serves the cached call");

  t.mock.timers.setTime(203_001); // past the TTL measured from settle
  const p4 = repoStatus(repo);
  assert.notEqual(p4, p1, "an expired entry runs a new status");
  await p4; // drain the child before the test ends
});
