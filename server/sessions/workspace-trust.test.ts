import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWorkspaceTrusted, trustWorkspace, trustedWorkspaces } from "./workspace-trust";

// The engine-scoped record behind the folder-trust prompts. Gemini CLI 0.53.0
// refuses to run headless in an untrusted folder, while Codex writes its own
// config consequence; Mirafold asks through the shell's permission strip and
// remembers each disclosed answer separately. The decision function is pure
// (the allow-set is injectable), so most of this is exact containment behavior
// rather than filesystem choreography.

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

test("a trusted directory, and anything under it, is trusted within one engine scope", () => {
  const trusted = new Set(["/home/k/proj"]);
  assert.equal(isWorkspaceTrusted("/home/k/proj", "gemini-cli", trusted), true);
  assert.equal(isWorkspaceTrusted("/home/k/proj/server/adapters", "gemini-cli", trusted), true);
});

test("an unlisted directory is not trusted — including a string-prefix neighbor", () => {
  const trusted = new Set(["/home/k/proj"]);
  assert.equal(isWorkspaceTrusted("/home/k/other", "gemini-cli", trusted), false);
  // "/home/k/project" starts with "/home/k/proj" as a STRING but is a
  // different folder — the walk compares path segments, never prefixes.
  assert.equal(isWorkspaceTrusted("/home/k/project", "gemini-cli", trusted), false);
  // Trusting a child must never trust its parent.
  assert.equal(isWorkspaceTrusted("/home/k", "gemini-cli", trusted), false);
});

test("an empty allow-set trusts nothing", () => {
  assert.equal(isWorkspaceTrusted("/home/k/proj", "gemini-cli", new Set()), false);
});

test("a yes is remembered only for the engine whose consequence was disclosed", () => {
  withTrustFile(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-ws-"));
    try {
      assert.equal(isWorkspaceTrusted(dir, "gemini-cli"), false, "unknown before the answer");
      trustWorkspace(dir, "gemini-cli");
      assert.equal(isWorkspaceTrusted(dir, "gemini-cli"), true, "Gemini trusted after its yes");
      assert.equal(isWorkspaceTrusted(dir, "codex"), false, "Gemini consent never authorizes Codex");
      trustWorkspace(dir, "gemini-cli");
      assert.equal(
        trustedWorkspaces("gemini-cli").size,
        1,
        "a repeat answer adds no duplicate row",
      );
      trustWorkspace(dir, "codex");
      assert.equal(isWorkspaceTrusted(dir, "codex"), true, "Codex requires and remembers its own yes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a legacy unscoped record migrates as Gemini-only consent", () => {
  withTrustFile((file) => {
    writeFileSync(file, JSON.stringify(["/home/k/proj"]));
    assert.equal(isWorkspaceTrusted("/home/k/proj", "gemini-cli"), true);
    assert.equal(isWorkspaceTrusted("/home/k/proj", "codex"), false);
  });
});

test("a malformed or missing record means 'nothing trusted', never a throw", () => {
  withTrustFile((file) => {
    assert.equal(trustedWorkspaces("gemini-cli").size, 0, "missing file");
    writeFileSync(file, "{not json");
    assert.equal(trustedWorkspaces("gemini-cli").size, 0, "malformed file");
    assert.equal(isWorkspaceTrusted("/anything", "gemini-cli"), false);
  });
});

test("MIRAFOLD_WORKSPACE_TRUST_FILE='' disables the record entirely", () => {
  const prev = process.env.MIRAFOLD_WORKSPACE_TRUST_FILE;
  process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = "";
  try {
    trustWorkspace("/home/k/proj", "gemini-cli"); // must not throw with nowhere to write
    assert.equal(trustedWorkspaces("gemini-cli").size, 0);
    assert.equal(isWorkspaceTrusted("/home/k/proj", "gemini-cli"), false);
  } finally {
    if (prev === undefined) delete process.env.MIRAFOLD_WORKSPACE_TRUST_FILE;
    else process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = prev;
  }
});

// AUDIT 2026-08-26: trust is granted on a project; a symlink INSIDE a trusted
// project that points elsewhere must not carry it (the lexical ancestry did:
// `proj/link → elsewhere` opened `elsewhere` as trusted). And the record is
// written privately, exclusively, never through a link.
test("AUDIT: a symlink inside a trusted project does not inherit its trust; the record is private", () => {
  withTrustFile((file) => {
    const base = mkdtempSync(path.join(os.tmpdir(), "mirafold-wstrust-link-"));
    const proj = path.join(base, "proj");
    const elsewhere = path.join(base, "elsewhere");
    mkdirSync(proj);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(proj, "link"));
    trustWorkspace(proj, "gemini-cli");
    assert.equal(isWorkspaceTrusted(path.join(proj, "sub-that-does-not-exist-yet"), "gemini-cli"), true, "a real subfolder inherits");
    assert.equal(isWorkspaceTrusted(path.join(proj, "link"), "gemini-cli"), false, "the link's target is another folder");
    assert.equal(isWorkspaceTrusted(elsewhere, "gemini-cli"), false);
    assert.equal(statSync(file).mode & 0o077, 0, "the record is owner-only");
    assert.equal(statSync(path.dirname(file)).mode & 0o077, 0, "so is its directory");
    assert.ok(!readdirSync(path.dirname(file)).some((n) => n.endsWith(".tmp")), "no temp file left behind");
    assert.ok(lstatSync(file).isFile());
    rmSync(base, { recursive: true, force: true });
  });
});

// Cold review (2026-08-26): after the realpath-only ancestry, the record
// stored the LEXICAL path while the check walked the REAL one — a workspace
// reached through a symlink (macOS /tmp, a symlinked ~/Projects) was never
// remembered and re-asked every session.
test("a workspace reached through a symlink is remembered under the form the check compares", () => {
  withTrustFile(() => {
    const base = mkdtempSync(path.join(os.tmpdir(), "mirafold-wstrust-via-link-"));
    const real = path.join(base, "real");
    const link = path.join(base, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    trustWorkspace(link, "codex");
    assert.equal(isWorkspaceTrusted(link, "codex"), true, "asked once, ever — via the link");
    assert.equal(isWorkspaceTrusted(real, "codex"), true, "…and via the real path");
    assert.equal(isWorkspaceTrusted(path.join(link, "sub"), "codex"), true);
    rmSync(base, { recursive: true, force: true });
  });
});
