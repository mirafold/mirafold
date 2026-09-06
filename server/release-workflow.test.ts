import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");

const workflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

test("npm publishing is tag-only and bound to the protected environment", () => {
  const publishStart = workflow.indexOf("\n  publish:\n");
  assert.notEqual(publishStart, -1, "publish job exists");
  const verify = workflow.slice(0, publishStart);
  const publish = workflow.slice(publishStart);

  assert.match(workflow, /^on:\n  push:\n    tags: \["v\*"\]\n\n/m);
  assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/m);
  assert.equal(workflow.match(/^    environment: npm-publish$/gm)?.length, 1);
  assert.match(publish, /^    environment: npm-publish$/m);
  assert.equal(workflow.match(/^      id-token: write$/gm)?.length, 1);
  assert.doesNotMatch(verify, /^      id-token: write$/m);
  assert.doesNotMatch(verify, /^\s+- run: npm publish/m);
  assert.match(publish, /^      id-token: write$/m);
  assert.doesNotMatch(publish, /--dry-run/);
});

test("the single-repository release typecheck excludes every sibling-dependent test", () => {
  const configPath = path.join(root, "tsconfig.ci.json");
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(loaded.error, undefined, "tsconfig.ci.json parses");
  const excluded = new Set<string>(loaded.config.exclude ?? []);

  // Tracked TypeScript paths only; every dotenv filename form is excluded
  // explicitly even though none can match the positive extensions.
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      ":(glob)**/*.ts",
      ":(glob)**/*.tsx",
      ":(exclude,glob)**/.env",
      ":(exclude,glob)**/.env.*",
      ":(exclude,glob)**/*.env",
      ":(exclude,glob)**/*.env.*",
    ],
    { cwd: root, encoding: "utf8" },
  ).split("\0").filter(Boolean);

  const outsideImporters = new Set<string>();
  for (const relativeFile of files) {
    const absoluteFile = path.join(root, relativeFile);
    const source = readFileSync(absoluteFile, "utf8");
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\()\s*["'](\.\.[^"']+)["']/g)) {
      const resolved = path.resolve(path.dirname(absoluteFile), match[1]);
      if (path.relative(root, resolved).startsWith(`..${path.sep}`)) {
        outsideImporters.add(relativeFile);
      }
    }
  }

  assert.ok(outsideImporters.size > 0, "the sibling-import guard exercises a real importer");
  for (const relativeFile of outsideImporters) {
    assert.ok(excluded.has(relativeFile), `${relativeFile} must be excluded from tsconfig.ci.json`);
  }
});
