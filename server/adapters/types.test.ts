import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { agentBin, capOutput, envWithout, installedAgentBin, outputFields, splitBudget, toolDetail } from "./types";

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

test("capOutput keeps a head and a tail of an over-cap result; the middle is counted, not implied (TF1.2)", () => {
  const total = 100_000;
  const input = "H".repeat(50_000) + "T".repeat(50_000);
  const r = capOutput(input);
  const { head, tail } = splitBudget(CAP);
  assert.equal(Buffer.byteLength(r.text, "utf8"), head);
  assert.equal(r.text, "H".repeat(head));
  assert.equal(r.tail, "T".repeat(tail));
  // A pre-TF client sees the head and every byte past it as elided.
  assert.equal(r.truncatedBytes, total - head);
  // A TF client sees exactly the middle that fell between head and tail.
  assert.equal(r.omittedBytes, total - head - tail);
  assert.equal(head + tail, CAP);
});

test("capOutput keeps the trailing failure line — the verdict is at the end", () => {
  const body = "log line\n".repeat(20_000);
  const verdict = "FAIL: 2 tests failed";
  const r = capOutput(body + verdict);
  assert.ok(r.tail?.endsWith(verdict));
  assert.ok(!r.text.includes(verdict));
});

test("capOutput never splits a character at either seam (TF1.2 multibyte boundary)", () => {
  const { head, tail } = splitBudget(CAP);
  // '€' is 3 bytes: place one straddling the head seam and one straddling the tail seam.
  const input = "a".repeat(head - 1) + "€" + "x".repeat(10_000) + "€" + "b".repeat(tail - 1);
  const r = capOutput(input);
  assert.ok(!r.text.includes("�") && !r.tail!.includes("�"));
  assert.equal(Buffer.byteLength(r.text, "utf8"), head - 1); // the straddling '€' is dropped whole
  assert.equal(Buffer.byteLength(r.tail!, "utf8"), tail - 1); // and so is the one at the tail seam
  assert.equal(r.tail, "b".repeat(tail - 1));
  const total = Buffer.byteLength(input, "utf8");
  assert.equal(r.omittedBytes, total - (head - 1) - (tail - 1));
  assert.equal(r.truncatedBytes, total - (head - 1));
  assert.ok(r.omittedBytes! >= 0);
});

test("capOutput at a zero budget retains nothing but still counts what was dropped", () => {
  const r = capOutput("hello world", 0);
  assert.deepEqual(r, { text: "", truncatedBytes: 11, omittedBytes: 11 });
});

test("capOutput at tiny budgets stays valid: no negative counts, no malformed text", () => {
  for (const cap of [1, 2, 3, 4, 5, 7]) {
    const r = capOutput("€€€€€€", cap); // 18 bytes of 3-byte chars
    assert.ok(!r.text.includes("�") && !(r.tail ?? "").includes("�"), `cap ${cap}`);
    assert.ok(Buffer.byteLength(r.text, "utf8") + Buffer.byteLength(r.tail ?? "", "utf8") <= cap, `cap ${cap} budget`);
    assert.ok(r.omittedBytes! >= 0 && r.truncatedBytes! >= 0, `cap ${cap} counts`);
    assert.equal(
      Buffer.byteLength(r.text, "utf8") + Buffer.byteLength(r.tail ?? "", "utf8") + r.omittedBytes!,
      18,
      `cap ${cap} accounting`,
    );
  }
});

test("outputFields spells the tool_result contract: exact results carry no counts", () => {
  assert.deepEqual(outputFields(capOutput("small")), { output: "small" });
  const big = outputFields(capOutput("x".repeat(CAP + 10)));
  assert.equal(big.output.length, splitBudget(CAP).head);
  assert.equal(big.tail!.length, splitBudget(CAP).tail);
  assert.equal(big.omittedBytes, 10);
  assert.equal(big.truncatedBytes, 10 + splitBudget(CAP).tail);
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
