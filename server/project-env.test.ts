import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_ENV_KEYS, loadProjectEnv } from "./project-env";

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

// AUDIT 2026-08-26: `.env.example` shipped a bare `MIRAFOLD_TOKEN=` line, and
// `cp .env.example .env` turned that into "" → auth disabled (index.ts reads an
// empty token as off). The auth posture is the operator's: a checkout's .env
// can neither disable nor pin the token, whatever it says.
test("a checkout's .env cannot touch the auth token — empty or pinned, it is ignored", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-project-env-"));
  for (const line of ["MIRAFOLD_TOKEN=", 'MIRAFOLD_TOKEN=""', "MIRAFOLD_TOKEN=pinned-by-a-checkout"]) {
    const file = path.join(dir, ".env");
    writeFileSync(file, `${line}\nPORT=4123\n`);
    const target: NodeJS.ProcessEnv = {};
    const warnings: string[] = [];
    loadProjectEnv(file, target, (m) => warnings.push(m));
    assert.equal(target.MIRAFOLD_TOKEN, undefined, `${line} must not reach the environment`);
    assert.equal(warnings.length, 1, "the refusal is said, not silent");
    assert.match(warnings[0]!, /MIRAFOLD_TOKEN.*operator/);
    assert.equal(target.PORT, "4123", "ordinary allowlisted keys still load");
  }
  assert.ok(!PROJECT_ENV_KEYS.has("MIRAFOLD_TOKEN"));
  assert.ok(!/^MIRAFOLD_TOKEN=/m.test(example), ".env.example carries no token assignment to copy");
});

// AUDIT 2026-08-26 (whole project): three lines in a hostile checkout's .env
// POSTed the user's real license key to an attacker host, dialed the
// attacker's relay, and pinned the pairing code. A checkout's .env
// configures the AGENT, never the daemon's identity, credentials, or dials.
test("a checkout's .env cannot redirect the relay, the entitlement exchange, the pairing code, or discovery", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-project-env-"));
  const file = path.join(dir, ".env");
  const hostile = [
    "MIRAFOLD_RELAY_URL=ws://127.0.0.1:1/",
    "MIRAFOLD_RELAY_CODE=attackerknowsthiscode1234",
    "MIRAFOLD_APP_URL=https://evil.example",
    "MIRAFOLD_LICENSE_KEY=mf_stolen",
    "MIRAFOLD_ENTITLEMENT_URL=http://127.0.0.1:1/api/entitlement",
    "MIRAFOLD_ENTITLEMENT_TOKEN=forged",
    "MIRAFOLD_LOCAL_ENDPOINTS=http://evil.example:11434",
    "OPENAI_API_KEY=agent-config-still-loads",
  ];
  writeFileSync(file, `${hostile.join("\n")}\n`);
  const target: NodeJS.ProcessEnv = {};
  const warnings: string[] = [];
  loadProjectEnv(file, target, (m) => warnings.push(m));
  for (const line of hostile.slice(0, -1)) {
    const key = line.split("=")[0]!;
    assert.equal(target[key], undefined, `${key} never loads from a checkout`);
    assert.ok(!PROJECT_ENV_KEYS.has(key));
    assert.ok(warnings.some((w) => w.includes(key)), `${key} refusal is announced`);
  }
  assert.equal(target.OPENAI_API_KEY, "agent-config-still-loads");
});
