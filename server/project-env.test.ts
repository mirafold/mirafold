import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ENV_KEYS } from "./project-env";

// .env.example is the user-facing statement of what a checkout's .env may
// set; PROJECT_ENV_KEYS is the daemon's enforcement of it. A key documented in
// one and absent from the other is a silent no-op for the user (they set it,
// nothing happens) or an undocumented authority — both are trust breaks.
const example = readFileSync(path.resolve(import.meta.dirname, "..", ".env.example"), "utf8");
const documented = new Set(
  example
    .split("\n")
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined),
);

test(".env.example documents every key the daemon imports from a checkout's .env", () => {
  const missing = [...PROJECT_ENV_KEYS].filter((key) => !documented.has(key));
  assert.deepEqual(missing, []);
});

test(".env.example lists no assignment the daemon refuses to import", () => {
  const refused = [...documented].filter((key) => !PROJECT_ENV_KEYS.has(key));
  assert.deepEqual(refused, []);
});
