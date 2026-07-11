import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version";
import { CLIENT_VERSION } from "../web/src/version";

// R.4g: a bug report must be able to name a version. The daemon inlines it
// at build time (server/version.ts), the web bundle announces its own copy
// back, and the launcher answers --version without booting anything.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "mirafold.js");

test("VERSION is the package semver", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test("daemon and client read the same package version", () => {
  assert.equal(CLIENT_VERSION, VERSION);
});

test("mirafold --version answers, fast, without booting a daemon", () => {
  const out = execFileSync(process.execPath, [BIN, "--version"]).toString().trim();
  assert.equal(out, VERSION);
});

test("mirafold --help prints usage and the flags", () => {
  const out = execFileSync(process.execPath, [BIN, "--help"]).toString();
  assert.match(out, /Usage: mirafold/);
  assert.match(out, /--no-open/);
  assert.match(out, /--version/);
});
