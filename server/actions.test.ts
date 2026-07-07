import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runActionTool, actionToolNames } from "./actions";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "genui-act-"));

test("workspace_ls lists a real subdirectory", () => {
  const base = tmp();
  mkdirSync(path.join(base, "sub"));
  writeFileSync(path.join(base, "sub", "f.txt"), "hi");
  const r = runActionTool("workspace_ls", { path: "sub" }, base);
  assert.equal(r.isError, false);
  assert.match(r.output, /f\.txt/);
});

test("workspace_ls handles '.'", () => {
  const base = tmp();
  writeFileSync(path.join(base, "a.txt"), "x");
  const r = runActionTool("workspace_ls", { path: "." }, base);
  assert.equal(r.isError, false);
  assert.match(r.output, /a\.txt/);
});

test("workspace_ls blocks a symlink escaping the workspace", () => {
  const base = tmp();
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
