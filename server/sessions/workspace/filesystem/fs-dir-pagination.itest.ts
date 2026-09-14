import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FsDirEntry, WireMsg } from "../../../protocol";
import { createSession, fixtureGit as git, startDaemon, type TestClient } from "../../../testing/itest-harness";
import { pagedDirectoryFixture } from "../../../testing/fixtures/paged-directory";

type Page = Extract<WireMsg, { type: "fs_dir" }>;
const listdir = async (client: TestClient, id: string, path: string, continuation?: string): Promise<Page> => {
  client.send({ type: "fs_listdir", id, path, ...(continuation ? { continuation } : {}) });
  return await client.waitFor(m => m.type === "fs_dir" && m.id === id, id) as Page;
};

test("fs_listdir pages over the real socket; later directories are reachable and tokens stay scoped", async t => {
  const fixture = pagedDirectoryFixture();
  t.after(() => fixture.close());
  const daemon = await startDaemon(fixture.env);
  t.after(() => daemon.stop());
  const { client, sessionId } = await createSession(daemon.port, "claude-code", { cwd: fixture.root });
  t.after(() => client.close());
  let page = await listdir(client, "page-0", "");
  assert.ok(page.continuation);
  assert.equal(page.entries.length, 2_000);
  assert.ok(page.entries.every(e => e.kind === "file"));
  const token = page.continuation;
  const second = await createSession(daemon.port, "claude-code", { cwd: fixture.root });
  t.after(() => second.client.close());
  second.client.send({ type: "attach", sessionId });
  await second.client.type("session_created");
  assert.match((await listdir(second.client, "foreign", "", token)).error ?? "", /no longer available/);
  const entries: FsDirEntry[] = [];
  for (let i = 1; ; i++) {
    assert.equal(page.error, undefined);
    assert.ok(page.entries.length <= 2_000);
    assert.ok(page.entries.reduce((n, e) => n + Buffer.byteLength(e.name), 0) <= 200_000);
    assert.equal("seq" in page, false);
    entries.push(...page.entries);
    if (!page.continuation) break;
    assert.ok(i < 8);
    page = await listdir(client, `page-${i}`, "", page.continuation);
  }
  assert.equal(entries.length, 10_001);
  assert.equal(new Set(entries.map(e => e.name)).size, 10_001);
  assert.deepEqual(entries.at(-1), { name: "late-directory", kind: "dir" });
  assert.deepEqual((await listdir(client, "nested", "late-directory")).entries,
    [{ name: "reachable.txt", kind: "file" }]);
  assert.match((await listdir(client, "spent", "", token)).error ?? "", /no longer available/);
});

test("Git filtering and deleted children survive pagination without duplicates", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-git-pages-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  for (const name of ["kept.txt", "removed.txt", "staged.ignored"]) writeFileSync(path.join(root, name), "before\n");
  writeFileSync(path.join(root, ".gitignore"), "*.ignored\n");
  git(root, "add", "-f", "--", ".gitignore", "kept.txt", "removed.txt", "staged.ignored");
  git(root, "commit", "-qm", "fixture");
  rmSync(path.join(root, "removed.txt"));
  git(root, "rm", "--cached", "--", "staged.ignored");
  writeFileSync(path.join(root, "kept.txt"), "after\n");
  writeFileSync(path.join(root, "omit.ignored"), "ignored\n");
  writeFileSync(path.join(root, "loose.txt"), "untracked\n");
  const daemon = await startDaemon({ FS_DIR_MAX_ENTRIES: "2", FS_DIR_MAX_NAME_BYTES: "24", FS_LISTDIR_STATUS_WAIT_MS: "2000" });
  t.after(() => daemon.stop());
  const { client } = await createSession(daemon.port, "claude-code", { cwd: root });
  t.after(() => client.close());
  const entries: FsDirEntry[] = [];
  let token: string | undefined;
  for (let i = 0; ; i++) {
    assert.ok(i < 10);
    const page = await listdir(client, `git-${i}`, "", token);
    assert.equal(page.error, undefined);
    assert.ok(page.entries.length <= 2);
    assert.ok(page.entries.reduce((n, e) => n + Buffer.byteLength(e.name), 0) <= 24);
    entries.push(...page.entries);
    token = page.continuation;
    if (!token) break;
  }
  assert.deepEqual(entries.map(e => e.name).sort(), [".gitignore", "kept.txt", "loose.txt", "removed.txt", "staged.ignored"]);
  const statuses = new Map(entries.map(e => [e.name, e.status]));
  assert.equal(statuses.get("kept.txt"), "M");
  assert.equal(statuses.get("loose.txt"), "U");
  assert.equal(statuses.get("removed.txt"), "D");
  assert.equal(statuses.get("staged.ignored"), "D");
});
