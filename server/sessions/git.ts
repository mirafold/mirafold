// The Explorer's git layer (Phase E.2): one-shot, bounded `git` invocations
// for the session root — the tracked+untracked tree with change status
// behind `fs_list`, and HEAD's version of a file behind `fs_diff`. Every
// call is execFile (no shell), timeboxed, buffer-capped, and settles to a
// TYPED result — "not a repo" and "no git binary" are ordinary degrade
// values, never throws, so a non-repo workspace falls back to the walk.
// Nothing here touches the wire or the registry; connection.ts composes.

import { execFile } from "node:child_process";
import path from "node:path";
import type { FsEntry } from "../protocol";

const GIT_TIMEOUT_MS = Number(process.env.FS_GIT_TIMEOUT_MS ?? 5_000);
// `git show` of a big blob is the largest legitimate output; the caller caps
// content for the wire — this only bounds process memory.
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

type RunResult =
  | { ok: true; stdout: Buffer }
  | { ok: false; notGit: boolean; code: number | null; stderr: string };

/** One bounded git invocation in `root`. Buffer stdout — `show` can be binary. */
const runGit = (root: string, args: string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "buffer" },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout });
        const errno = (err as NodeJS.ErrnoException).code;
        const text = String(stderr);
        resolve({
          ok: false,
          // No git binary anywhere ≡ not a repo for our purposes: degrade.
          notGit: errno === "ENOENT" || /not a git repository/i.test(text),
          code: typeof errno === "number" ? errno : null,
          stderr: text,
        });
      },
    );
  });

/**
 * Reject a wire path before it goes anywhere near `git show`: git resolves
 * `HEAD:./<rel>` against the repo, not the filesystem, so `inside()`'s
 * realpath jail can't see it — and a `../` here could read repo files above
 * a subdirectory session's root. Pure textual containment: relative, /-
 * separated, no `..` segments, no NUL/backslash. Exported for the Tier-1 pin.
 */
export const cleanRelPath = (rel: string): string | null => {
  if (rel.length === 0 || rel.length > 4_096) return null;
  if (rel.includes("\0") || rel.includes("\\")) return null;
  if (path.isAbsolute(rel)) return null;
  const segments = rel.split("/");
  if (segments.some((s) => s === ".." || s === "")) return null;
  return segments.filter((s) => s !== ".").join("/") || null;
};

/**
 * Parse `git status --porcelain=v1 -z` output into root-relative path →
 * collapsed status char. -z records are `XY <path>\0`, EXCEPT renames/copies:
 * `XY <to>\0<from>\0` — TWO fields, and a naive single-field split misaligns
 * every record after the first rename. Renames collapse to A(to) + D(from)
 * for v1. Status collapse: `??` → U (untracked); any D → D; any A → A;
 * everything else that reaches porcelain (M/T/U-conflict/…) → M. Exported
 * pure for the Tier-1 pin.
 */
export const parseStatusZ = (out: string): Map<string, string> => {
  const byPath = new Map<string, string>();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 4) continue; // trailing empty field / junk
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      const from = fields[++i]; // the second field of this record
      byPath.set(p, "A");
      // Rename: the source is gone → D. Copy: the source still exists,
      // unchanged — marking it D would lie about a file sitting on disk.
      if (xy.includes("R") && from) byPath.set(from, "D");
      continue;
    }
    if (xy === "??") byPath.set(p, "U");
    else if (xy.includes("D")) byPath.set(p, "D");
    else if (xy.includes("A")) byPath.set(p, "A");
    else byPath.set(p, "M");
  }
  return byPath;
};

export type GitTree =
  | { entries: FsEntry[]; truncated: boolean }
  | { notGit: true }
  | { error: string };

// Same caps as the walk in fs-explorer.ts — the reply rides the same wire.
const MAX_ENTRIES = Number(process.env.FS_TREE_MAX_ENTRIES ?? 4_000);
const MAX_PATH_BYTES = Number(process.env.FS_TREE_MAX_PATH_BYTES ?? 400_000);

/**
 * Git's view of the session root: tracked + untracked-unignored files
 * (`ls-files --cached --others --exclude-standard`, cwd-relative), each with
 * its collapsed status char. Two path relativities meet here: ls-files
 * speaks CWD-relative, porcelain speaks REPO-ROOT-relative — the
 * `rev-parse --show-prefix` strip reconciles them (the subdirectory-session
 * trap). Staged deletions are gone from ls-files but still real: status-only
 * D paths are merged in, so a deleted file stays visible in the tree.
 */
export async function gitTree(root: string): Promise<GitTree> {
  const ls = await runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (!ls.ok) return ls.notGit ? { notGit: true } : { error: gitErr("ls-files", ls) };
  const [status, prefixRes] = await Promise.all([
    runGit(root, ["status", "--porcelain=v1", "-z", "--", "."]),
    runGit(root, ["rev-parse", "--show-prefix"]),
  ]);
  if (!status.ok) return status.notGit ? { notGit: true } : { error: gitErr("status", status) };
  const prefix = prefixRes.ok ? String(prefixRes.stdout).trim() : "";

  const rawStatus = parseStatusZ(String(status.stdout));
  // Re-key repo-root-relative status paths to session-root-relative; changes
  // outside a subdirectory session's subtree are not this session's story.
  const statusByRel = new Map<string, string>();
  for (const [p, s] of rawStatus) {
    if (prefix === "") statusByRel.set(p, s);
    else if (p.startsWith(prefix)) statusByRel.set(p.slice(prefix.length), s);
  }

  const seen = new Set<string>();
  const entries: FsEntry[] = [];
  let pathBytes = 0;
  let truncated = false;
  const push = (rel: string) => {
    if (rel === "" || seen.has(rel)) return;
    seen.add(rel);
    if (entries.length >= MAX_ENTRIES || pathBytes + rel.length > MAX_PATH_BYTES) {
      truncated = true;
      return;
    }
    const status = statusByRel.get(rel);
    entries.push({ path: rel, ...(status ? { status } : {}) });
    pathBytes += Buffer.byteLength(rel, "utf8");
  };
  for (const rel of String(ls.stdout).split("\0")) push(rel);
  // Status-only paths: staged deletes (and rename sources) missing from
  // ls-files. Sorted merge keeps the reply deterministic.
  for (const rel of [...statusByRel.keys()].sort()) push(rel);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, truncated };
}

export type GitShow =
  | { content: Buffer }
  | { absentInHead: true }
  | { notGit: true }
  | { error: string };

// `git show` failures that mean "this path has no HEAD version" — a brand-new
// file, or any path in a repo whose HEAD is unborn (fresh init, no commits).
const ABSENT_RE =
  /(exists on disk, but not in|does not exist in|bad revision|unknown revision|invalid object name|ambiguous argument 'HEAD')/i;

/** HEAD's version of `rel` (a cleanRelPath-validated session-root-relative
 *  path). The `./` form makes git resolve it cwd-relative — no prefix math. */
export async function gitShowHead(root: string, rel: string): Promise<GitShow> {
  const r = await runGit(root, ["show", `HEAD:./${rel}`]);
  if (r.ok) return { content: r.stdout };
  if (r.notGit) return { notGit: true };
  if (ABSENT_RE.test(r.stderr)) return { absentInHead: true };
  // Submodules (gitlinks), weird objects: honest degrade, never a throw.
  return { error: "no diff available for this entry" };
}

const gitErr = (op: string, r: { code: number | null; stderr: string }): string =>
  `git ${op} failed${r.stderr ? `: ${r.stderr.slice(0, 200)}` : ""}`;
