import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import {
  isSecretFile,
  makeCanUseTool,
  resolvesToSecretFile,
  type PermissionAsker,
} from "./permissions";

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

function harness(answer: boolean, root = ROOT, caseInsensitiveFs = false) {
  const asked: string[] = [];
  const ask: PermissionAsker = async (tool) => {
    asked.push(tool);
    return answer;
  };
  const canUse = makeCanUseTool(root, ask, caseInsensitiveFs);
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

// The guard resolves the target with path.resolve, so these routes to the
// SAME daemon file must also deny, not just the bare relative string (Q.5).

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

// 2026-08-11 audit: on a case-insensitive filesystem (macOS default, Windows)
// `.Env`/`.ENV` name the SAME file as `.env`, so a case-sensitive string match
// let an auto-allowed `Read(".Env")` read the daemon's secret with no prompt —
// the exact zero-click route the guard exists to close. The compare must fold
// case exactly where the host filesystem does.
test("audit 2026-08-11: case-variant .env spellings deny on a case-insensitive FS", async () => {
  const { call } = harness(true, ROOT, true);
  const variants = [".Env", ".ENV", ".eNv", ".env.LOCAL", ".ENV.LOCAL"];
  for (const name of variants) {
    for (const [tool, field] of READERS) {
      assert.equal(
        (await call(tool, { [field]: name })).behavior,
        "deny",
        `${tool} @ ${name} must deny on a case-insensitive FS`,
      );
    }
  }
  // The absolute-path route folds too.
  const absUpper = path.resolve(process.cwd(), ".ENV");
  assert.equal((await call("Read", { file_path: absUpper })).behavior, "deny");
});

test("audit 2026-08-11: a case-sensitive FS keeps .ENV as a different, allowed file", async () => {
  // Linux resolves `.ENV` to a genuinely different file; folding it in would
  // wrongly deny a legitimate workspace file, so case-sensitive stays exact.
  const { call } = harness(false, ROOT, false);
  assert.notEqual((await call("Read", { file_path: ".ENV" })).behavior, "deny");
  // The real secret is still denied regardless.
  assert.equal((await call("Read", { file_path: ".env" })).behavior, "deny");
});

test("audit 2026-08-11: resolvesToSecretFile folds case only when told to", () => {
  const secret = path.resolve(process.cwd(), ".env");
  const upper = path.resolve(process.cwd(), ".ENV");
  assert.equal(resolvesToSecretFile(secret, false), true);
  assert.equal(resolvesToSecretFile(upper, false), false);
  assert.equal(resolvesToSecretFile(upper, true), true);
});

test("audit 2026-08-11: isSecretFile folds case only when told to", () => {
  assert.equal(isSecretFile("/x/.ENV", false), false);
  assert.equal(isSecretFile("/x/.ENV", true), true);
  assert.equal(isSecretFile("/x/.Env.Local", true), true);
  assert.equal(isSecretFile("/x/.env", false), true);
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

test("isSecretFile: basename rule — env files anywhere, nothing else (E.1)", () => {
  for (const p of ["/x/.env", "/x/deep/nest/.env.local", ".env", "sub/.env"]) {
    assert.equal(isSecretFile(p), true, `${p} is secret`);
  }
  for (const p of ["/x/.envrc", "/x/env", "/x/foo.env", "/x/.env.example", "/x/environment.ts"]) {
    assert.equal(isSecretFile(p), false, `${p} is not`);
  }
});
