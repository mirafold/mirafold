import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { agentBin, capOutput, envWithout, installedAgentBin, toolDetail } from "./types";

// The default cap is 64 KB (TOOL_OUTPUT_CAP_BYTES), read at module load.
const CAP = 64_000;

function withEnv(patch: NodeJS.ProcessEnv, run: () => void): void {
  const saved = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function executable(file: string): void {
  writeFileSync(file, "");
  if (process.platform !== "win32") chmodSync(file, 0o755);
}

test("installedAgentBin honors the operator override — but a missing file is not an install", () => {
  const key = "MIRAFOLD_TEST_AGENT_BIN";
  // Absolute + missing: NOT detected as installed (no "ready" card for a
  // binary that can only ENOENT) — yet the spawn path keeps the operator's
  // explicit choice so the first turn fails honestly. This split is also how
  // the harnesses force an agent absent on machines that really have it.
  withEnv({ [key]: "/operator/chosen/agent" }, () => {
    assert.equal(installedAgentBin(key, "agent"), undefined);
    assert.equal(agentBin(key, "agent"), "/operator/chosen/agent");
  });
  // Absolute + present: both agree.
  withEnv({ [key]: process.execPath }, () => {
    assert.equal(installedAgentBin(key, "agent"), process.execPath);
    assert.equal(agentBin(key, "agent"), process.execPath);
  });
  // A bare name can't be stat'ed — trusted as-is (resolved at spawn time).
  withEnv({ [key]: "custom-agent" }, () => {
    assert.equal(installedAgentBin(key, "agent"), "custom-agent");
    assert.equal(agentBin(key, "agent"), "custom-agent");
  });
});

test("installedAgentBin finds PATH executables and preserves the non-SDK ENOENT fallback", () => {
  const key = "MIRAFOLD_TEST_AGENT_BIN";
  const name = `mirafold-agent-${process.pid}`;
  const shadowDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-agent-shadow-"));
  // A same-named directory can be searchable (`X_OK`) but is not executable.
  // PATH lookup must keep going to the real file in the next directory.
  mkdirSync(path.join(shadowDir, name));
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-agent-bin-"));
  const file = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  executable(file);
  try {
    withEnv({ [key]: undefined, PATH: `${shadowDir}${path.delimiter}${dir}` }, () => {
      assert.equal(installedAgentBin(key, name), realpathSync.native(file));
      assert.equal(agentBin(key, name), realpathSync.native(file));
      assert.equal(installedAgentBin(key, `${name}-missing`), undefined);
      assert.equal(agentBin(key, `${name}-missing`), `${name}-missing`);
    });
  } finally {
    rmSync(shadowDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installedAgentBin ignores the project-local executables npm adds to PATH", () => {
  const key = "MIRAFOLD_TEST_AGENT_BIN";
  const name = `mirafold-local-agent-${process.pid}`;
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-agent-project-"));
  const npmBin = path.join(root, "node_modules", ".bin");
  mkdirSync(npmBin, { recursive: true });
  const file = path.join(npmBin, process.platform === "win32" ? `${name}.cmd` : name);
  executable(file);
  try {
    withEnv({ [key]: undefined, PATH: npmBin }, () => {
      assert.equal(installedAgentBin(key, name), undefined);
      assert.equal(agentBin(key, name), name);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capOutput leaves sub-cap text untouched", () => {
  const r = capOutput("hello");
  assert.equal(r.text, "hello");
  assert.equal(r.truncatedBytes, undefined);
});

test("capOutput leaves exactly-at-cap text untouched", () => {
  const r = capOutput("a".repeat(CAP));
  assert.equal(r.truncatedBytes, undefined);
  assert.equal(Buffer.byteLength(r.text, "utf8"), CAP);
});

test("capOutput truncates over-cap ASCII and reports the elided byte count", () => {
  const total = 100_000;
  const r = capOutput("a".repeat(total));
  assert.equal(Buffer.byteLength(r.text, "utf8"), CAP);
  assert.equal(r.truncatedBytes, total - CAP);
});

test("capOutput cuts on a byte boundary, replacing a straddling multibyte char", () => {
  // 63999 ASCII bytes + a 3-byte '€': the cap at byte 64000 falls inside '€'.
  const input = "a".repeat(CAP - 1) + "€";
  const r = capOutput(input);
  // The partial lead byte decodes to U+FFFD rather than crashing.
  assert.equal(r.text.at(-1), "�");
  assert.equal(r.truncatedBytes, Buffer.byteLength(input, "utf8") - CAP); // = 2
});

test("toolDetail returns the first present salient key in precedence order", () => {
  assert.equal(toolDetail({ command: "ls", file_path: "a" }), "ls");
  assert.equal(toolDetail({ file_path: "a", pattern: "p" }), "a");
  assert.equal(toolDetail({ command: "", file_path: "a" }), "a"); // empty string skipped
});

test("toolDetail falls back to sliced JSON, and undefined for empty/non-objects", () => {
  assert.equal(toolDetail({}), undefined);
  assert.equal(toolDetail(null), undefined);
  assert.equal(toolDetail("nope"), undefined);
  const long = toolDetail({ foo: "x".repeat(300) });
  assert.ok(long && long.length <= 160 && long.startsWith("{"));
});

// AUDIT 2026-08-26: an engine's `env` tool call lands in the transcript and
// the checkpoint, and project-configured MCP servers inherit the engine's
// env — the daemon's OWN credentials must not be there to read.
test("envWithout always strips the daemon's own credentials, keeps the agent's", () => {
  withEnv(
    {
      MIRAFOLD_TOKEN: "t",
      MIRAFOLD_LICENSE_KEY: "mf_k",
      MIRAFOLD_RELAY_CODE: "code",
      MIRAFOLD_ENTITLEMENT_TOKEN: "ent",
      OPENAI_API_KEY: "sk-agent",
      GEMINI_API_KEY: "g",
    },
    () => {
      const env = envWithout("GEMINI_API_KEY");
      for (const k of ["MIRAFOLD_TOKEN", "MIRAFOLD_LICENSE_KEY", "MIRAFOLD_RELAY_CODE", "MIRAFOLD_ENTITLEMENT_TOKEN", "GEMINI_API_KEY"]) {
        assert.equal(env[k], undefined, `${k} withheld`);
      }
      assert.equal(env.OPENAI_API_KEY, "sk-agent");
      assert.equal(envWithout().OPENAI_API_KEY, "sk-agent");
      assert.equal(envWithout().MIRAFOLD_RELAY_CODE, undefined);
    },
  );
});
