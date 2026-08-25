// Workspace trust — "may an agent engine run in this folder at all?"
//
// Distinct from git-trust.ts next door, which answers "may THIS repo's git
// config run programs during our own read-only git calls?" That list is a
// hand-edited escape hatch for a rare condition and is empty for essentially
// every project; reusing it here would have left Gemini broken for everyone.
//
// Why this exists at all: Gemini CLI 0.53.0 refuses to run headless in a
// folder it hasn't been told to trust — a project can carry its own
// `.gemini/settings.json` defining MCP servers, i.e. programs. Their terminal
// asks them once and remembers; Mirafold asks the same question through the
// shell's own permission strip and remembers it here, so the answer stays the
// user's. Blanket-trusting whatever folder is open would quietly undo the
// protection, and would contradict how git-trust.ts answers the
// identical question for git.
//
// Engine-neutral by design even though Gemini is today's only caller: the
// question ("did the user vouch for this directory?") is not Gemini-specific,
// and a second engine adopting a folder gate must not grow a second list.

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../log";

function defaultTrustFile(): string {
  return path.join(stateDir(), "trusted-workspaces.json");
}

/** The record's path, or null when disabled (MIRAFOLD_WORKSPACE_TRUST_FILE="").
 *  Resolved per call, like git-trust's twin, so tests and a hand-edit both
 *  take effect without a restart. */
export const workspaceTrustFile = (): string | null =>
  process.env.MIRAFOLD_WORKSPACE_TRUST_FILE === undefined
    ? defaultTrustFile()
    : process.env.MIRAFOLD_WORKSPACE_TRUST_FILE || null;

/** Directories the user has vouched for. A missing or malformed file means
 *  "none" — the safe reading, never a crash. */
export function trustedWorkspaces(): Set<string> {
  const file = workspaceTrustFile();
  if (!file) return new Set();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(parsed) ? parsed : ((parsed as { workspaces?: unknown })?.workspaces ?? []);
    return new Set(Array.isArray(list) ? list.filter((w): w is string => typeof w === "string") : []);
  } catch {
    return new Set();
  }
}

/** Canonical form for both storing and comparing: absolute, and resolved
 *  through symlinks when the directory exists (a session can arrive by either
 *  spelling of the same folder). */
function canonical(dir: string): string[] {
  const abs = path.resolve(dir);
  try {
    const real = realpathSync(abs);
    return real === abs ? [abs] : [abs, real];
  } catch {
    return [abs]; // may not exist yet — the raw form still answers
  }
}

/**
 * Did the user vouch for this directory? True for a trusted directory and for
 * anything beneath it: trust is granted on a project, and a session opened in
 * a subdirectory of that project is the same vouching.
 *
 * The allow-set is injectable so the decision stays a pure function to test.
 */
export function isWorkspaceTrusted(dir: string, trusted = trustedWorkspaces()): boolean {
  if (!trusted.size) return false;
  for (const start of canonical(dir)) {
    for (let cur = start, prev = ""; cur !== prev; prev = cur, cur = path.dirname(cur)) {
      if (trusted.has(cur)) return true;
    }
  }
  return false;
}

/**
 * Record the user's yes. Idempotent, and never throws into a turn: a
 * unwritable state dir must degrade to "asks again next time", not fail the
 * prompt the user just answered.
 */
export function trustWorkspace(dir: string): void {
  const file = workspaceTrustFile();
  if (!file) return;
  const [, real] = canonical(dir);
  const entry = real ?? path.resolve(dir);
  try {
    const all = trustedWorkspaces();
    if (all.has(entry)) return;
    all.add(entry);
    mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a truncated list
    // that silently re-asks for every project the user already trusted.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...all], null, 2));
    renameSync(tmp, file);
  } catch {
    /* trust simply isn't remembered this time */
  }
}
