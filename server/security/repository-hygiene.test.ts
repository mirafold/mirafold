import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);

const qsAtSecurityFloor = (version: string): boolean => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major > 6 || (major === 6 && (minor > 16 || (minor === 16 && patch >= 0)));
};

test("DA.5: Git ignores dotenv secret-name variants while retaining the public root template", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-ignore-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    writeFileSync(path.join(dir, ".gitignore"), readFileSync(path.join(ROOT, ".gitignore"), "utf8"));
    const ignored = (candidate: string) =>
      spawnSync(
        "git",
        ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--quiet", candidate],
        { cwd: dir },
      ).status === 0;

    // Path-only probes: no dotenv file is created or read by this test.
    for (const candidate of [
      ".env",
      ".env.local",
      ".env.production",
      "service.env",
      "service.env.local",
      "nested/.env",
      "nested/.env.local",
      "nested/.env.example",
      "nested/service.env.production",
    ]) {
      assert.equal(ignored(candidate), true, candidate);
    }
    assert.equal(ignored(".env.example"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DA.5: the production lock keeps qs on the advisory-patched line", () => {
  const lock = readFileSync(path.join(ROOT, "yarn.lock"), "utf8");
  const locked = [...lock.matchAll(/^(?:qs@|"qs@)[^\n]*:\n  version "([^"]+)"/gm)].map(
    (match) => match[1],
  );
  assert.ok(locked.length > 0, "a production qs lock entry exists");
  for (const version of locked) {
    assert.ok(qsAtSecurityFloor(version), `locked qs ${version} is below the 6.16.0 security floor`);
  }

  const installed = (require("qs/package.json") as { version: string }).version;
  assert.ok(qsAtSecurityFloor(installed), `installed qs ${installed} is below the 6.16.0 security floor`);
});
