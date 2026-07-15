import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { makeCanUseTool, type PermissionAsker } from "./permissions";

// The SDK's canUseTool passes an options object; our policy ignores it, so a
// minimal-but-complete stub is enough to exercise the callback.
const opts = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
// SECRET_PATHS resolves `.env` against process.cwd(); use it as the workspace so
// a relative ".env" target lands on the guarded path.
const ROOT = process.cwd();
// The four auto-allowed readers the guard covers, with their path argument.
const READERS: [string, string][] = [
  ["Read", "file_path"],
  ["NotebookRead", "notebook_path"],
  ["Grep", "path"],
  ["Glob", "path"],
];

function harness(answer: boolean, root = ROOT) {
  const asked: string[] = [];
  const ask: PermissionAsker = async (tool) => {
    asked.push(tool);
    return answer;
  };
  const canUse = makeCanUseTool(root, ask);
  const call = async (tool: string, input: Record<string, unknown>) => {
    const r = await canUse(tool, input, opts);
    assert.ok(r, "canUseTool unexpectedly returned null");
    return r;
  };
  return { asked, call };
}

test("denies reading the daemon .env through any auto-allowed reader", async () => {
  const { call } = harness(true);
  const cases: [string, string][] = [
    ["Read", "file_path"],
    ["NotebookRead", "notebook_path"],
    ["Grep", "path"],
    ["Glob", "path"],
  ];
  for (const [tool, field] of cases) {
    const r = await call(tool, { [field]: ".env" });
    assert.equal(r.behavior, "deny", `${tool} at .env should deny`);
  }
  assert.equal((await call("Read", { file_path: ".env.local" })).behavior, "deny");
});

// Q.5 — the guard resolves the target with path.resolve, so these routes to the
// SAME daemon file must also deny, not just the bare relative string.

test("Q.5 denies an absolute path to the daemon .env, through every reader", async () => {
  const { call } = harness(true);
  const abs = path.resolve(process.cwd(), ".env");
  for (const [tool, field] of READERS) {
    assert.equal((await call(tool, { [field]: abs })).behavior, "deny", `${tool} @ absolute .env`);
  }
  assert.equal(
    (await call("Read", { file_path: path.resolve(process.cwd(), ".env.local") })).behavior,
    "deny",
  );
});

test("Q.5 denies a ../ traversal that resolves onto the daemon .env", async () => {
  const { call } = harness(true);
  // root is process.cwd() here, so sub/deeper/../../.env === <cwd>/.env.
  for (const [tool, field] of READERS) {
    const r = await call(tool, { [field]: "sub/deeper/../../.env" });
    assert.equal(r.behavior, "deny", `${tool} @ traversal`);
  }
});

test("Q.5 cross-cwd: absolute + traversal routes to the daemon .env still deny; the session's own .env is out of scope", async () => {
  // A session running in a DIFFERENT directory than where the daemon launched.
  const otherDir = mkdtempSync(path.join(os.tmpdir(), "genui-perm-"));
  const { call } = harness(true, otherDir);
  const abs = path.resolve(process.cwd(), ".env"); // the daemon's real secret

  for (const [tool, field] of READERS) {
    // absolute path to the DAEMON's env: denied regardless of session cwd
    assert.equal((await call(tool, { [field]: abs })).behavior, "deny", `${tool} cross-cwd absolute`);
    // a relative traversal from otherDir back to the daemon's env: also denied
    const back = path.relative(otherDir, abs);
    assert.equal((await call(tool, { [field]: back })).behavior, "deny", `${tool} cross-cwd traversal`);
  }

  // A bare ".env" now resolves to otherDir/.env — a DIFFERENT file, outside the
  // guard's scope (it protects the daemon's own secrets), so it is not denied.
  assert.notEqual((await call("Read", { file_path: ".env" })).behavior, "deny");
});

test("local read-only tools and mcp__ui__* are allowed without asking", async () => {
  const { asked, call } = harness(false);
  for (const tool of ["Read", "Glob", "Grep", "TodoWrite", "Task", "NotebookRead"]) {
    const r = await call(tool, { file_path: "README.md", path: "server", pattern: "x" });
    assert.equal(r.behavior, "allow", `${tool} should allow`);
  }
  assert.equal((await call("mcp__ui__render_card", {})).behavior, "allow");
  assert.deepEqual(asked, []); // nothing prompted
});

test("network + consequential tools ask, and deny when the user declines", async () => {
  const { asked, call } = harness(false);
  const tools = ["WebFetch", "WebSearch", "Bash", "Write", "Edit", "SomeUnknownTool"];
  for (const tool of tools) {
    const r = await call(tool, { url: "https://x", command: "ls", file_path: "a" });
    assert.equal(r.behavior, "deny", `${tool} should deny when declined`);
  }
  assert.deepEqual(asked, tools); // every one reached the prompt
});

test("a consequential tool is allowed when the user approves", async () => {
  const { call } = harness(true);
  assert.equal((await call("Bash", { command: "ls" })).behavior, "allow");
});

test("the deny message names the declined tool", async () => {
  const { call } = harness(false);
  const r = await call("Bash", { command: "ls" });
  assert.equal(r.behavior, "deny");
  if (r.behavior === "deny") assert.match(r.message, /Bash/);
});
