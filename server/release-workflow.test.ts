import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

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
