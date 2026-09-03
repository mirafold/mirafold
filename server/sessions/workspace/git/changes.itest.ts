import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientMsg, WireMsg } from "../../../protocol";
import { startDaemon, TestClient, type Daemon } from "../../../testing/itest-harness";

// CR.1 against a real daemon and WebSocket: a Projects-style parent session
// receives every nested repo's changed files in explicit groups, a repo
// subdirectory stays scoped to itself, and the new query keeps the folder tree's
// per-connection throttle/error-reply contract.

type ChangeSet = Extract<WireMsg, { type: "fs_change_set" }>;

let daemon: Daemon;
let workspace: string;
let alpha: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.email=test@invalid", "-c", "user.name=Mirafold Test", ...args],
    { stdio: "pipe" },
  );

const initRepo = (root: string): void => {
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet");
};

const openSession = async (cwd: string): Promise<TestClient> => {
  const client = new TestClient(daemon.port);
  await client.opened();
  await client.type("agents");
  client.send({ type: "create", agent: "claude-code", cwd } as ClientMsg);
  await client.type("session_created");
  return client;
};

const waitForChanges = (client: TestClient, id: string): Promise<ChangeSet> =>
  client.waitFor(
    (message) => message.type === "fs_change_set" && message.id === id,
    `fs_change_set ${id}`,
  ) as Promise<ChangeSet>;

before(async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "diff-panel-itest-"));
  alpha = path.join(workspace, "alpha");
  const beta = path.join(workspace, "group", "beta");
  initRepo(alpha);
  initRepo(beta);

  mkdirSync(path.join(alpha, "src"));
  writeFileSync(path.join(alpha, "src", "app.ts"), "before\n");
  writeFileSync(path.join(alpha, "moveme.ts"), "move\n");
  git(alpha, "add", "--all");
  git(alpha, "commit", "--quiet", "-m", "baseline");
  writeFileSync(path.join(alpha, "src", "app.ts"), "after\n");
  git(alpha, "mv", "moveme.ts", "moved.ts");
  writeFileSync(path.join(beta, "new.ts"), "new\n");

  daemon = await startDaemon({ FS_MIN_INTERVAL_MS: "60000" });
});

after(async () => {
  await daemon?.stop();
  rmSync(workspace, { recursive: true, force: true });
});

test("CR.1: fs_changes returns the complete parent-workspace set grouped by repository", async () => {
  const client = await openSession(workspace);
  client.send({ type: "fs_changes", id: "changes-1" });

  const reply = await waitForChanges(client, "changes-1");
  assert.deepEqual(reply.repos, [
    {
      root: "alpha",
      entries: [
        { path: "alpha/moved.ts", status: "A" },
        { path: "alpha/moveme.ts", status: "D" },
        { path: "alpha/src/app.ts", status: "M" },
      ],
    },
    { root: "group/beta", entries: [{ path: "group/beta/new.ts", status: "U" }] },
  ]);
  assert.equal(reply.truncated, undefined);
  assert.equal(reply.error, undefined);
  assert.ok(!("seq" in reply), "query replies are per-viewport, not replay history");

  client.send({ type: "fs_changes", id: "changes-2" });
  const throttled = await waitForChanges(client, "changes-2");
  assert.deepEqual(throttled.repos, []);
  assert.match(throttled.error ?? "", /arriving too fast/);
  client.close();
});

test("CR.1: a subdirectory session returns one group with session-relative changed paths", async () => {
  const client = await openSession(path.join(alpha, "src"));
  client.send({ type: "fs_changes", id: "scope-1" });
  const reply = await waitForChanges(client, "scope-1");
  assert.deepEqual(reply.repos, [
    { root: "", entries: [{ path: "app.ts", status: "M" }] },
  ]);
  assert.equal(reply.error, undefined);
  client.close();
});
