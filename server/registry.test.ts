import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCwd } from "./registry";

test("resolveCwd defaults to the process cwd", () => {
  assert.equal(resolveCwd(undefined), process.cwd());
});

test("resolveCwd resolves an existing dir to an absolute path", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "genui-cwd-"));
  assert.equal(resolveCwd(base), path.resolve(base));
});

test("resolveCwd expands a leading ~", () => {
  assert.equal(resolveCwd("~"), os.homedir());
});

test("resolveCwd throws on a missing directory", () => {
  assert.throws(() => resolveCwd("/no/such/dir/genui-nope"), /no such directory/);
});

test("resolveCwd throws when the path is a file, not a directory", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "genui-cwd-"));
  const file = path.join(base, "f.txt");
  writeFileSync(file, "x");
  assert.throws(() => resolveCwd(file), /not a directory/);
});
