import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { availableAgents } from "./index";

// R.4i: the per-provider policy, at the detection layer. This REVERSES the R.4b
// behavior (a Claude subscription login used to count as live): Anthropic's
// terms don't allow a subscription in a third-party app, so a login-only machine
// is now `blocked` (not live, with the API-key fix on the picker), while an API
// key or a local endpoint (ANTHROPIC_BASE_URL) is live. CLAUDE_CONFIG_DIR
// (Claude Code's own dir override) is the seam that makes this hermetic.

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "DEFAULT_MODEL",
] as const;

const claude = () => availableAgents().find((a) => a.agent === "claude-code")!;

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

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "genui-creds-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("claude-code: no env keys and no credentials file → not live, not blocked (demo)", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty }, () => {
      const c = claude();
      assert.equal(c.live, false);
      assert.notEqual(c.blocked, true);
    });
  });
});

test("claude-code: a subscription login's credentials file alone → BLOCKED, not live (R.4i)", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, ".credentials.json"), "{}");
    withEnv({ CLAUDE_CONFIG_DIR: dir }, () => {
      const c = claude();
      assert.equal(c.live, false, "a Claude subscription must not run — Anthropic's terms");
      assert.equal(c.blocked, true, "and it's surfaced as blocked, not a bare demo");
    });
  });
});

test("claude-code: an Anthropic API key (or auth token) is live and not blocked", () => {
  withTempDir((empty) => {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      withEnv({ CLAUDE_CONFIG_DIR: empty, [key]: "x" }, () => {
        const c = claude();
        assert.equal(c.live, true, key);
        assert.notEqual(c.blocked, true, key);
      });
    }
  });
});

test("claude-code: a local/BYO endpoint (ANTHROPIC_BASE_URL) is live — even over a login", () => {
  withTempDir((dir) => {
    // A subscription login file is present, but the user pointed the SDK at a
    // local endpoint — that's `local` (open, anything goes), so it wins.
    writeFileSync(path.join(dir, ".credentials.json"), "{}");
    withEnv({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_BASE_URL: "http://localhost:11434" }, () => {
      const c = claude();
      assert.equal(c.live, true);
      assert.notEqual(c.blocked, true);
    });
  });
});

test("R.4k: a local endpoint shows its host as the picker detail", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty, ANTHROPIC_BASE_URL: "http://localhost:11434" }, () => {
      const c = claude();
      assert.equal(c.live, true);
      assert.match(String(c.detail), /local endpoint/);
      assert.match(String(c.detail), /localhost:11434/);
    });
  });
});

test("R.4k: a malformed local endpoint falls back to a plain label, not a raw echo", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty, ANTHROPIC_BASE_URL: "not-a-valid-url" }, () => {
      const c = claude();
      assert.equal(c.live, true);
      assert.equal(c.detail, "local endpoint"); // no host, and no echoed raw value
    });
  });
});

test("R.4k: a configured model shows as the picker detail", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty, ANTHROPIC_API_KEY: "x", DEFAULT_MODEL: "claude-sonnet-5" }, () => {
      const c = claude();
      assert.equal(c.live, true);
      assert.equal(c.detail, "claude-sonnet-5");
    });
  });
});

test("R.4k: no detail on a non-live agent", () => {
  withTempDir((empty) => {
    withEnv({ CLAUDE_CONFIG_DIR: empty }, () => {
      assert.equal(claude().detail, undefined);
    });
  });
});
