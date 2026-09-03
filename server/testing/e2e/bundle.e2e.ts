import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// What the browser bundle carries is a shipping decision, not just a build
// detail: every viewport downloads it, and on the relay path so does a paired
// phone. Tier 3 because `yarn test:e2e` rebuilds dist first — these assertions
// are only meaningful against a fresh build.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const bundleJs = (): string => {
  const dir = path.join(ROOT, "dist", "assets");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 0, "no built JS in dist/assets — run yarn build");
  return files.map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
};

// The 2026-07-25 audit found the WHOLE package.json inlined into the bundle —
// every dependency and version range, every script — because version.ts used a
// default import to read one string. A named import tree-shakes; this fails if
// anything ever inlines the manifest again.
test("the browser bundle carries the version string, never the whole package.json", () => {
  const js = bundleJs();
  const manifestOnly = [
    "packageManager",
    "devDependencies",
    "resolutions",
    "test:server",
    "@lydell/node-pty", // a server-only dependency: its name has no business here
  ];
  for (const marker of manifestOnly) {
    assert.ok(!js.includes(marker), `package.json leaked into the browser bundle: "${marker}"`);
  }

  const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(
    js.includes(`"${version}"`) || js.includes(`\`${version}\``),
    `the client version (${version}) is missing from the bundle — CLIENT_VERSION is what the daemon logs a skewed pair against`,
  );
});
