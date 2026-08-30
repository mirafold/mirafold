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
// Consent is ENGINE-SCOPED. Gemini's yes discloses a project settings write;
// Codex's yes discloses a different write in the user's Codex config. A bare
// folder allow-list would let either answer silently authorize the other's
// undisclosed consequence.

import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stateDir } from "../log";

function defaultTrustFile(): string {
  return path.join(stateDir(), "trusted-workspaces.json");
}

export type WorkspaceTrustScope = "gemini-cli" | "codex" | "claude-code" | "opencode";
const TRUST_SCOPES: WorkspaceTrustScope[] = ["gemini-cli", "codex", "claude-code", "opencode"];
type TrustSets = Record<WorkspaceTrustScope, Set<string>>;

const emptyTrustSets = (): TrustSets => ({
  "gemini-cli": new Set(),
  codex: new Set(),
  "claude-code": new Set(),
  opencode: new Set(),
});

/** The record's path, or null when disabled (MIRAFOLD_WORKSPACE_TRUST_FILE="").
 *  Resolved per call, like git-trust's twin, so tests and a hand-edit both
 *  take effect without a restart. */
export const workspaceTrustFile = (): string | null =>
  process.env.MIRAFOLD_WORKSPACE_TRUST_FILE === undefined
    ? defaultTrustFile()
    : process.env.MIRAFOLD_WORKSPACE_TRUST_FILE || null;

/** Directories the user has vouched for, separated by the engine whose
 * consequence the prompt disclosed. A missing or malformed file means
 * "none" — the safe reading, never a crash. Legacy arrays and
 * `{ workspaces: [...] }` records predate Codex trust and therefore migrate
 * as Gemini-only consent. */
function readTrustSets(): TrustSets {
  const out = emptyTrustSets();
  const file = workspaceTrustFile();
  if (!file) return out;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const legacy = Array.isArray(parsed)
      ? parsed
      : (parsed as { workspaces?: unknown } | null)?.workspaces;
    if (Array.isArray(legacy)) {
      out["gemini-cli"] = new Set(
        legacy.filter((w): w is string => typeof w === "string"),
      );
      return out;
    }
    const scopes = (parsed as { scopes?: unknown } | null)?.scopes;
    if (typeof scopes !== "object" || scopes === null) return out;
    for (const scope of TRUST_SCOPES) {
      const list = (scopes as Record<string, unknown>)[scope];
      if (Array.isArray(list)) {
        out[scope] = new Set(list.filter((w): w is string => typeof w === "string"));
      }
    }
    return out;
  } catch {
    return out;
  }
}

export function trustedWorkspaces(scope: WorkspaceTrustScope): Set<string> {
  return readTrustSets()[scope];
}

/** Canonical form for both storing and comparing: absolute, and resolved
 *  through symlinks when the directory exists (a session can arrive by either
 *  spelling of the same folder). */
function canonical(dir: string): string[] {
  // The REAL path only: trust is granted on a project, and a symlink INSIDE
  // a trusted project pointing elsewhere must not inherit it lexically
  // (audit 2026-08-26 — `proj/link → elsewhere` opened `elsewhere` as
  // trusted). A path that does not exist yet resolves through its nearest
  // existing ancestor, so `link/new-subfolder` still lands under the real
  // project.
  const abs = path.resolve(dir);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return [path.join(realpathSync(cur), ...tail)];
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return [abs];
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Did the user vouch for this directory? True for a trusted directory and for
 * anything beneath it: trust is granted on a project, and a session opened in
 * a subdirectory of that project is the same vouching.
 *
 * The allow-set is injectable so the decision stays a pure function to test.
 */
export function isWorkspaceTrusted(
  dir: string,
  scope: WorkspaceTrustScope,
  trusted = trustedWorkspaces(scope),
): boolean {
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
export function trustWorkspace(dir: string, scope: WorkspaceTrustScope): void {
  const file = workspaceTrustFile();
  if (!file) return;
  let tmpToClean: string | undefined;
  // The SAME form isWorkspaceTrusted compares: the realpath when it exists.
  const [entry] = canonical(dir);
  try {
    const all = readTrustSets();
    if (all[scope].has(entry)) return;
    all[scope].add(entry);
    // Private dir and an exclusive, never-followed temp file (a fixed
    // `.tmp` name under a shared mode was the sibling of the checkpoint
    // store's own discipline — audit 2026-08-26).
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash mid-write must not leave a truncated list
    // that silently re-asks for every project the user already trusted.
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    tmpToClean = tmp;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(
        fd,
      JSON.stringify(
        {
          version: 2,
          scopes: Object.fromEntries(
            TRUST_SCOPES.map((name) => [name, [...all[name]]]),
          ),
        },
        null,
        2,
      ),
      );
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch {
    /* trust simply isn't remembered this time — and no temp file lingers */
    if (tmpToClean) {
      try {
        unlinkSync(tmpToClean);
      } catch {
        /* nothing to remove */
      }
    }
  }
}
