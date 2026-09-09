import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runActionTool, actionToolNames, inside } from "./actions";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "genui-act-"));

test("workspace containment accepts canonical children including a filesystem root, but rejects escapes", (t) => {
  const base = tmp();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  const child = path.join(workspace, "child");
  const outside = path.join(base, "workspace-other");
  mkdirSync(child, { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, path.join(workspace, "escape"));
  symlinkSync(workspace, path.join(base, "workspace-link"));
  const root = path.parse(realpathSync(base)).root;
  assert.equal(inside(workspace, "child"), realpathSync(child));
  assert.equal(inside(path.join(base, "workspace-link"), "child"), realpathSync(child));
  assert.equal(inside(root, child), realpathSync(child));
  assert.equal(inside(root, "."), root);
  assert.equal(inside(workspace, outside), null);
  assert.equal(inside(workspace, "escape"), null);
});

test("workspace_ls lists a real subdirectory", (t) => {
  const base = tmp();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(path.join(base, "sub"));
  writeFileSync(path.join(base, "sub", "f.txt"), "hi");
  const r = runActionTool("workspace_ls", { path: "sub" }, base);
  assert.equal(r.isError, false);
  assert.match(r.output, /f\.txt/);
});

test("workspace_ls handles '.'", (t) => {
  const base = tmp();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(path.join(base, "a.txt"), "x");
  const r = runActionTool("workspace_ls", { path: "." }, base);
  assert.equal(r.isError, false);
  assert.match(r.output, /a\.txt/);
});

test("workspace_ls blocks a symlink escaping the workspace", (t) => {
  const base = tmp();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  symlinkSync(os.tmpdir(), path.join(base, "escape")); // points above the workspace
  const r = runActionTool("workspace_ls", { path: "escape" }, base);
  assert.equal(r.isError, true);
  assert.match(r.output, /escapes/);
});

test("off-allowlist tool names, including prototype properties, are rejected", () => {
  for (const name of ["secret_exfil", "constructor", "__proto__"]) {
    assert.deepEqual(runActionTool(name, {}, os.tmpdir()), {
      output: `Action tool "${name}" is not allowlisted.`,
      isError: true,
    });
  }
});

test("invalid args are rejected", () => {
  const r = runActionTool("workspace_ls", { path: 123 as unknown as string }, os.tmpdir());
  assert.equal(r.isError, true);
  assert.match(r.output, /Invalid arguments/);
});

test("workspace_ls is on the allowlist", () => {
  assert.ok(actionToolNames.includes("workspace_ls"));
});

// 2026-07-29 bughunt: statSync follows symlinks and throws on a dangling
// one, and the throw escaped the whole listing — one broken link (or a file
// the agent deleted between readdir and stat) made every sibling invisible.

test("workspace_ls survives a dangling symlink — the row is marked, siblings stay listed", () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, "real.txt"), "hello");
    symlinkSync(path.join(dir, "gone.txt"), path.join(dir, "dangling"));
    const res = runActionTool("workspace_ls", {}, dir);
    assert.equal(res.isError, false);
    assert.match(res.output, /real\.txt/);
    assert.match(res.output, /\?\s+dangling/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace_ls bounds flat-directory work and reports truncation", () => {
  const dir = tmp();
  try {
    for (let i = 0; i < 2_001; i++) {
      writeFileSync(path.join(dir, `entry-${String(i).padStart(4, "0")}.txt`), "x");
    }

    const result = runActionTool("workspace_ls", {}, dir);

    assert.equal(result.isError, false);
    assert.match(result.output, /\(listing truncated\)$/);
    assert.ok(result.output.split("\n").length <= 2_001);
    assert.ok(Buffer.byteLength(result.output, "utf8") <= 64_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
