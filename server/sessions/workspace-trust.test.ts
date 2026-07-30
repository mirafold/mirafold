import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWorkspaceTrusted, trustWorkspace, trustedWorkspaces } from "./workspace-trust";

// The record behind the Gemini folder-trust prompt (P.6b). Gemini CLI 0.53.0
// refuses to run headless in an untrusted folder; Mirafold asks once through
// the shell's permission strip and remembers the answer here. The decision
// function is pure (the allow-set is injectable), so most of this is exact
// containment behavior rather than filesystem choreography.

const withTrustFile = (fn: (file: string) => void) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-wstrust-"));
  const file = path.join(dir, "trusted-workspaces.json");
  const prev = process.env.MIRAFOLD_WORKSPACE_TRUST_FILE;
  process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = file;
  try {
    fn(file);
  } finally {
    if (prev === undefined) delete process.env.MIRAFOLD_WORKSPACE_TRUST_FILE;
    else process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a trusted directory, and anything under it, is trusted", () => {
  const trusted = new Set(["/home/k/proj"]);
  assert.equal(isWorkspaceTrusted("/home/k/proj", trusted), true);
  assert.equal(isWorkspaceTrusted("/home/k/proj/server/adapters", trusted), true);
});

test("an unlisted directory is not trusted — including a string-prefix neighbor", () => {
  const trusted = new Set(["/home/k/proj"]);
  assert.equal(isWorkspaceTrusted("/home/k/other", trusted), false);
  // "/home/k/project" starts with "/home/k/proj" as a STRING but is a
  // different folder — the walk compares path segments, never prefixes.
  assert.equal(isWorkspaceTrusted("/home/k/project", trusted), false);
  // Trusting a child must never trust its parent.
  assert.equal(isWorkspaceTrusted("/home/k", trusted), false);
});

test("an empty allow-set trusts nothing", () => {
  assert.equal(isWorkspaceTrusted("/home/k/proj", new Set()), false);
});

test("a yes is remembered, and is idempotent", () => {
  withTrustFile(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-ws-"));
    try {
      assert.equal(isWorkspaceTrusted(dir), false, "unknown before the answer");
      trustWorkspace(dir);
      assert.equal(isWorkspaceTrusted(dir), true, "trusted after");
      trustWorkspace(dir);
      assert.equal(trustedWorkspaces().size, 1, "a repeat answer adds no duplicate row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a malformed or missing record means 'nothing trusted', never a throw", () => {
  withTrustFile((file) => {
    assert.equal(trustedWorkspaces().size, 0, "missing file");
    writeFileSync(file, "{not json");
    assert.equal(trustedWorkspaces().size, 0, "malformed file");
    assert.equal(isWorkspaceTrusted("/anything"), false);
  });
});

test("MIRAFOLD_WORKSPACE_TRUST_FILE='' disables the record entirely", () => {
  const prev = process.env.MIRAFOLD_WORKSPACE_TRUST_FILE;
  process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = "";
  try {
    trustWorkspace("/home/k/proj"); // must not throw with nowhere to write
    assert.equal(trustedWorkspaces().size, 0);
    assert.equal(isWorkspaceTrusted("/home/k/proj"), false);
  } finally {
    if (prev === undefined) delete process.env.MIRAFOLD_WORKSPACE_TRUST_FILE;
    else process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = prev;
  }
});
