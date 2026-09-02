import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runActionTool, actionToolNames } from "./actions";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "genui-act-"));

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

test("off-allowlist tool names are rejected", () => {
  const r = runActionTool("secret_exfil", {}, os.tmpdir());
  assert.equal(r.isError, true);
  assert.match(r.output, /not allowlisted/);
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
