import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { availableAgents } from "./index";

// R.4b: a Claude subscription login (`claude` in a terminal — writes
// ~/.claude/.credentials.json, no API key) must count as live credentials:
// it's the likeliest launch user's setup, and before this check that user
// was shown "no credentials · demo". CLAUDE_CONFIG_DIR (Claude Code's own
// dir override) is the seam that makes the check testable hermetically.

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
] as const;

const claudeLive = () =>
  availableAgents().find((a) => a.agent === "claude-code")!.live;

function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("claude-code: no env keys and no credentials file → not live (demo)", () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), "genui-creds-"));
  try {
    withEnv({ CLAUDE_CONFIG_DIR: empty }, () => {
      assert.equal(claudeLive(), false);
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("claude-code: a subscription login's credentials file alone → live", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "genui-creds-"));
  try {
    writeFileSync(path.join(dir, ".credentials.json"), "{}");
    withEnv({ CLAUDE_CONFIG_DIR: dir }, () => {
      assert.equal(claudeLive(), true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude-code: each env credential alone still counts as live", () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), "genui-creds-"));
  try {
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
    ]) {
      withEnv({ CLAUDE_CONFIG_DIR: empty, [key]: "x" }, () => {
        assert.equal(claudeLive(), true, key);
      });
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
