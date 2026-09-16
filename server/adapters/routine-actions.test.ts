import { test } from "node:test";
import assert from "node:assert/strict";
import { routineActions } from "./routine-actions";

test("R2: only exact known built-ins classify; shell commands and unknown tools never do", () => {
  assert.deepEqual(routineActions("claude-code", "Read", { file_path: "src/a.ts" }), [{ kind: "read", target: "src/a.ts" }]);
  assert.deepEqual(routineActions("claude-code", "Grep", { pattern: "TODO", path: "src" }), [{ kind: "search", target: "TODO" }]);
  assert.deepEqual(routineActions("claude-code", "Glob", { pattern: "**/*.ts" }), [{ kind: "list", target: "**/*.ts" }]);
  assert.equal(routineActions("claude-code", "Bash", { command: "cat a.ts" }), undefined, "a shell command is never inferred read-only");
  assert.equal(routineActions("claude-code", "Edit", { file_path: "a" }), undefined);
  assert.equal(routineActions("claude-code", "read", { filePath: "a" }), undefined, "names are exact per engine");
  assert.deepEqual(routineActions("opencode", "read", { filePath: "/w/a.ts" }), [{ kind: "read", target: "/w/a.ts" }]);
  assert.deepEqual(routineActions("opencode", "grep", { pattern: "x" }), [{ kind: "search", target: "x" }]);
  assert.deepEqual(routineActions("gemini-cli", "read_file", { absolute_path: "/w/b.ts" }), [{ kind: "read", target: "/w/b.ts" }]);
  assert.deepEqual(routineActions("gemini-cli", "grep_search", { pattern: "foo" }), [{ kind: "search", target: "foo" }]);
  assert.deepEqual(routineActions("gemini-cli", "read_many_files", { paths: ["a", "b", "c"] }), [{ kind: "read", target: "a (+2)" }]);
  assert.equal(routineActions("gemini-cli", "run_shell_command", { command: "ls" }), undefined);
  assert.equal(routineActions("codex", "Shell", { command: "ls" }), undefined, "Codex classifies only from commandActions");
});

test("PR #120 review: prototype-named tools resolve to nothing, never to an inherited property", () => {
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(routineActions("claude-code", name, { file_path: "x" }), undefined, name);
    assert.equal(routineActions("opencode", name, {}), undefined, name);
  }
});

test("targets are clamped and control-visible; a missing target is simply absent", () => {
  const [a] = routineActions("claude-code", "Read", { file_path: "x".repeat(400) })!;
  assert.ok(a.target!.length <= 200);
  const [b] = routineActions("claude-code", "Grep", { pattern: "a‮b" })!;
  assert.equal(b.target, "a‹U+202E›b");
  assert.deepEqual(routineActions("claude-code", "Read", {}), [{ kind: "read" }]);
  assert.deepEqual(routineActions("claude-code", "Read", null), [{ kind: "read" }]);
});
