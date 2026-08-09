import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { envFlag, envInt } from "./env";
import { loadProjectEnv } from "./project-env";

// 2026-07-29 bughunt: Number(garbage) is NaN, and NaN WIDENED two policies —
// ws treats maxPayload NaN|0=0 as UNLIMITED, and setInterval(fn, NaN) clamps
// to 1 ms, which terminated every viewport before its pong could arrive. A
// malformed knob must fall back to its default, never widen.

test("envInt falls back on garbage, never NaN", () => {
  process.env.GENUI_TEST_KNOB = "1MB";
  assert.equal(envInt("GENUI_TEST_KNOB", 1_000_000), 1_000_000);
  process.env.GENUI_TEST_KNOB = "30s";
  assert.equal(envInt("GENUI_TEST_KNOB", 30_000), 30_000);
  process.env.GENUI_TEST_KNOB = "-5";
  assert.equal(envInt("GENUI_TEST_KNOB", 7), 7);
  delete process.env.GENUI_TEST_KNOB;
});

test("envInt honors real values, unset, and blank", () => {
  process.env.GENUI_TEST_KNOB = "2500";
  assert.equal(envInt("GENUI_TEST_KNOB", 7), 2500);
  process.env.GENUI_TEST_KNOB = "0";
  assert.equal(envInt("GENUI_TEST_KNOB", 7), 0);
  process.env.GENUI_TEST_KNOB = "";
  assert.equal(envInt("GENUI_TEST_KNOB", 7), 7);
  delete process.env.GENUI_TEST_KNOB;
  assert.equal(envInt("GENUI_TEST_KNOB", 7), 7);
});

// 2026-07-29 bughunt: Boolean("0") is true, so MIRAFOLD_DEBUG=0 — a user
// turning debug OFF — turned it on.

test("envFlag: 0/false/blank are OFF, anything else set is ON", () => {
  assert.equal(envFlag(undefined), false);
  assert.equal(envFlag(""), false);
  assert.equal(envFlag("0"), false);
  assert.equal(envFlag("false"), false);
  assert.equal(envFlag("FALSE"), false);
  assert.equal(envFlag("1"), true);
  assert.equal(envFlag("true"), true);
});

test("project .env imports supported data but never process identity", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mirafold-project-env-"));
  const file = path.join(tmp, ".env");
  writeFileSync(
    file,
    [
      "OPENAI_API_KEY=from-project",
      "PORT=4321",
      'MIRAFOLD_TOKEN="x&calc|whoami"',
      "MIRAFOLD_CODEX_BIN=./repo-codex",
      "MIRAFOLD_GEMINI_BIN=./repo-gemini",
      "NODE_OPTIONS=--require=./repo-loader.cjs",
      "NODE_PATH=./repo-modules",
      "PATH=./node_modules/.bin",
      "SHELL=./repo-shell",
      "UNRELATED_PROJECT_SETTING=untouched",
    ].join("\n"),
  );
  const target: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "from-parent",
    NODE_OPTIONS: "--trace-warnings",
    MIRAFOLD_CODEX_BIN: "/operator/codex",
  };

  try {
    loadProjectEnv(file, target);
    assert.equal(target.OPENAI_API_KEY, "from-parent", "parent-process values win");
    assert.equal(target.PORT, "4321");
    assert.equal(target.MIRAFOLD_TOKEN, "x&calc|whoami");
    assert.equal(target.MIRAFOLD_CODEX_BIN, "/operator/codex");
    assert.equal(target.MIRAFOLD_GEMINI_BIN, undefined);
    assert.equal(target.NODE_OPTIONS, "--trace-warnings", "the file cannot replace a loader hook");
    assert.equal(target.NODE_PATH, undefined);
    assert.equal(target.PATH, undefined);
    assert.equal(target.SHELL, undefined);
    assert.equal(target.UNRELATED_PROJECT_SETTING, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
