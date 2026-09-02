import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectEnv } from "./project-env";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "mirafold-project-config-"));

test("project configuration loads from an ordinary bounded file", (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "project-config");
  writeFileSync(file, "PORT=4123\n");
  const target: NodeJS.ProcessEnv = {};

  loadProjectEnv(file, target);

  assert.equal(target.PORT, "4123");
});

test("project configuration refuses a symlink before folder trust", (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outside = path.join(dir, "outside-config");
  const link = path.join(dir, "project-config-link");
  writeFileSync(outside, "OPENAI_API_KEY=outside\n");
  symlinkSync(outside, link);
  const target: NodeJS.ProcessEnv = {};

  loadProjectEnv(link, target);

  assert.equal(target.OPENAI_API_KEY, undefined);
});

test("project configuration refuses a file larger than its startup ceiling", (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "oversized-project-config");
  writeFileSync(file, `PORT=4123\n${"#".repeat(1024 * 1024)}\n`);
  const target: NodeJS.ProcessEnv = {};

  loadProjectEnv(file, target);

  assert.equal(target.PORT, undefined);
});
