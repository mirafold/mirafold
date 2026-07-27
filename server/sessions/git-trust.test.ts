import { test } from "node:test";
import assert from "node:assert/strict";
import { assessConfig } from "./git-trust";

// Which effective-config entries are treated as "this repo wants git to run
// a program", and how each is neutralized. The empirical half — that these
// three settings really do execute, and that the disabling really stops
// them — is proven against a real repo in git-trust.itest.ts.

const cfg = (o: Record<string, string>) => new Map(Object.entries(o));

test("an ordinary repo's config is silent — nothing risky, nothing disabled", () => {
  const r = assessConfig(cfg({ "core.bare": "false", "remote.origin.url": "git@x:y.git" }));
  assert.deepEqual(r.risky, []);
  assert.deepEqual(r.disableArgs, []);
  assert.equal(r.unscannable, false);
});

test("core.fsmonitor naming a program is risky; the builtin/off forms are not", () => {
  const risky = assessConfig(cfg({ "core.fsmonitor": "/tmp/hook.sh" }));
  assert.deepEqual(risky.risky, [{ key: "core.fsmonitor", value: "/tmp/hook.sh" }]);
  assert.deepEqual(risky.disableArgs, ["-c", "core.fsmonitor=false"]);
  for (const inert of ["true", "TRUE", " true ", "false", "", "1", "0"]) {
    assert.deepEqual(
      assessConfig(cfg({ "core.fsmonitor": inert })).risky,
      [],
      `core.fsmonitor=${JSON.stringify(inert)} names no program`,
    );
  }
});

test("filter drivers are risky by clean/process only, under any driver name", () => {
  const r = assessConfig(
    cfg({
      "filter.anything.clean": "./run-me",
      "filter.other.process": "./run-me-too",
      "filter.anything.smudge": "./not-run-by-our-commands",
      "filter.anything.required": "true",
    }),
  );
  assert.deepEqual(
    r.risky.map((x) => x.key).sort(),
    ["filter.anything.clean", "filter.other.process"],
  );
  assert.deepEqual(r.disableArgs, [
    "-c",
    "filter.anything.clean=",
    "-c",
    "filter.other.process=",
  ]);
});

test("more filter drivers than we will neutralize marks the repo unscannable", () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 65; i++) many[`filter.d${i}.clean`] = "./x";
  assert.equal(assessConfig(cfg(many)).unscannable, true);
  const few: Record<string, string> = {};
  for (let i = 0; i < 64; i++) few[`filter.d${i}.clean`] = "./x";
  assert.equal(assessConfig(cfg(few)).unscannable, false);
});
