// The Explorer's git layer (Phase E.2): one-shot, bounded `git` invocations
// for the session root — the tracked+untracked tree with change status
// behind `fs_list`, and HEAD's version of a file behind `fs_diff`. Every
// call is execFile (no shell), timeboxed, buffer-capped, and settles to a
// TYPED result — "not a repo" and "no git binary" are ordinary degrade
// values, never throws, so a non-repo workspace falls back to the walk.
// Nothing here touches the wire or the registry; connection.ts composes.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { FsDirEntry, FsEntry } from "../protocol";
import { GIT_TIMEOUT_MS, invalidateRepoTrustCache, repoTrust } from "./git-trust";
// The walk's caps, shared (fs-explorer.ts) — both replies ride the same wire.
import { FS_TREE_MAX_ENTRIES, FS_TREE_MAX_PATH_BYTES } from "./fs-explorer";

// `git show` of a big blob is the largest legitimate output; the caller caps
// content for the wire — this only bounds process memory.
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

type RunResult =
  | { ok: true; stdout: Buffer }
  | { ok: false; notGit: boolean; code: number | null; stderr: string };

/** One bounded git invocation in `root`, with the repo's own
 *  program-running settings neutralized unless the user allowed that repo
 *  (git-trust.ts — the daemon runs git automatically, so a browsed repo must
 *  not get to run code by configuration alone). A repo naming more filter
 *  drivers than we will neutralize is refused outright, degrading to the
 *  plain non-git listing.
 *  `--no-optional-locks` because these are BACKGROUND reads over a watched
 *  tree (Phase W): a plain `git status` may take `.git/index.lock` and
 *  rewrite the index's stat cache — a write the watcher would hear, ringing
 *  a bell whose refetch runs another status… our own reads must never feed
 *  the doorbell. It also happens to stop the one hook (`post-index-change`)
 *  that our commands would otherwise fire (probed). */
const runGit = async (root: string, args: string[]): Promise<RunResult> => {
  const trust = await repoTrust(root);
  if (trust.unscannable) {
    return { ok: false, notGit: true, code: null, stderr: "repo config not scannable" };
  }
  return runGitRaw(root, [...trust.disableArgs, ...args]);
};

const runGitRaw = (root: string, args: string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "-C", root, ...args],
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
 * everything else that reaches porcelain (M/T/U-conflict/…) → M. A wholly-
 * untracked directory arrives collapsed to ONE `?? dir/` record — that's a
 * prefix, not a file, so it lands in `untrackedDirs` (slashless, the
 * parseStatusIgnoredZ convention) instead of masquerading as a file status
 * (2026-07-28 fix: it used to ship as a phantom `dir/` tree entry while the
 * real files inside carried no status). Exported pure for the Tier-1 pin.
 */
export const parseStatusZ = (
  out: string,
): { files: Map<string, string>; untrackedDirs: Set<string> } => {
  const files = new Map<string, string>();
  const untrackedDirs = new Set<string>();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 4) continue; // trailing empty field / junk
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      const from = fields[++i]; // the second field of this record
      files.set(p, "A");
      // Rename: the source is gone → D. Copy: the source still exists,
      // unchanged — marking it D would lie about a file sitting on disk.
      if (xy.includes("R") && from) files.set(from, "D");
      continue;
    }
    if (xy === "??") {
      if (p.endsWith("/")) untrackedDirs.add(p.slice(0, -1));
      else files.set(p, "U");
    } else if (xy.includes("D")) files.set(p, "D");
    else if (xy.includes("A")) files.set(p, "A");
    else files.set(p, "M");
  }
  return { files, untrackedDirs };
};

export type GitTree =
  | { entries: FsEntry[]; truncated: boolean }
  | { notGit: true }
  | { error: string };

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
  for (const [p, s] of rawStatus.files) {
    if (prefix === "") statusByRel.set(p, s);
    else if (p.startsWith(prefix)) statusByRel.set(p.slice(prefix.length), s);
  }
  // Untracked-dir prefixes, re-keyed the same way. "" means the session root
  // itself sits inside the collapsed dir — everything unlisted is untracked.
  const untrackedDirs: string[] = [];
  for (const d of rawStatus.untrackedDirs) {
    if (prefix === "") untrackedDirs.push(d);
    else if ((d + "/").startsWith(prefix)) untrackedDirs.push(d.slice(prefix.length));
    else if (prefix.startsWith(d + "/")) untrackedDirs.push("");
  }
  const inUntrackedDir = (rel: string) =>
    untrackedDirs.some((d) => (d === "" ? true : rel.startsWith(d + "/")));

  const seen = new Set<string>();
  const entries: FsEntry[] = [];
  let pathBytes = 0;
  let truncated = false;
  const push = (rel: string) => {
    if (rel === "" || seen.has(rel)) return;
    seen.add(rel);
    if (entries.length >= FS_TREE_MAX_ENTRIES || pathBytes + rel.length > FS_TREE_MAX_PATH_BYTES) {
      truncated = true;
      return;
    }
    const status = statusByRel.get(rel) ?? (inUntrackedDir(rel) ? "U" : undefined);
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

// --- The per-repo layer for the lazy tree (E2.3) ---
//
// A Projects-style session root holds several repos side by side, so git
// fidelity becomes per-NESTED-repo: each directory listing is decorated by
// the repo that actually contains it — its own ignore rules, its own status
// — and a directory outside any repo stays the plain lister's.

/**
 * The repo that contains `realDir`, or null if none: nearest ancestor with a
 * `.git` entry (a DIRECTORY for an ordinary repo; a FILE for worktrees and
 * submodules — existsSync covers both, and `git -C` accepts both). Nearest
 * wins, so a repo nested inside another repo gets its own view. The walk
 * runs to the filesystem root, not the session root, because a session
 * rooted at a SUBDIRECTORY of a repo (the Phase E trap) finds its repo
 * above the jail — same discovery rule git itself uses.
 */
export const findRepoRoot = (realDir: string): string | null => {
  let dir = realDir;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

/** `realPath`'s repo-root-relative, /-separated path — the unit every
 *  per-repo lookup keys on ("" = the repo root itself). `realPath` must be
 *  at or beneath `repoRoot` (findRepoRoot guarantees it for its own result). */
export const repoRelPath = (repoRoot: string, realPath: string): string =>
  path.relative(repoRoot, realPath).split(path.sep).join("/");

export type RepoStatusData = {
  /** Repo-root-relative FILE path → collapsed status char (M/A/D/U). */
  files: Map<string, string>;
  /** Wholly-untracked dirs porcelain collapses to one `?? dir/` record —
   *  everything beneath one is untracked without its own record. */
  untrackedDirs: Set<string>;
  /** Ignored paths (`!!` records): files exact, dirs stored without the
   *  trailing slash — everything beneath an ignored dir is ignored too. */
  ignored: Set<string>;
};

export type RepoStatus = RepoStatusData | { notGit: true } | { error: string };

/**
 * Parse `git status --porcelain=v1 -z --ignored` into the per-repo view.
 * Same -z framing rules as parseStatusZ (the legacy whole-tree parser):
 * rename/copy records carry TWO fields, renames collapse to A(to) + D(from),
 * copies never mark the source, and the trailing-slash dir collapse lands in
 * its own set. New here: `!!` (ignored) gets a set of its own too.
 * Exported pure for the Tier-1 pin.
 */
export const parseStatusIgnoredZ = (out: string): RepoStatusData => {
  const files = new Map<string, string>();
  const untrackedDirs = new Set<string>();
  const ignored = new Set<string>();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 4) continue; // trailing empty field / junk
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      const from = fields[++i]; // the second field of this record
      files.set(p, "A");
      if (xy.includes("R") && from) files.set(from, "D");
      continue;
    }
    if (xy === "!!") ignored.add(p.endsWith("/") ? p.slice(0, -1) : p);
    else if (xy === "??") {
      if (p.endsWith("/")) untrackedDirs.add(p.slice(0, -1));
      else files.set(p, "U");
    } else if (xy.includes("D")) files.set(p, "D");
    else if (xy.includes("A")) files.set(p, "A");
    else files.set(p, "M");
  }
  return { files, untrackedDirs, ignored };
};

// One git child at a time across ALL per-repo status queries — the E-phase
// one-git-child-in-flight discipline extended to E2.3: an open-panel
// prefetch burst spanning N repos QUEUES N calls (each request still gets
// its reply), it never forks N subprocesses at once.
let repoQueue: Promise<unknown> = Promise.resolve();
const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
  const run = repoQueue.then(job, job);
  repoQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

// Per-repo cache, keyed by repo root: the prefetch burst shares ONE status
// subprocess per repo (concurrent callers coalesce on the cached promise).
// Invalidation is the TTL plus Phase W's watcher bell (below) — the TTL
// stays short enough that a turn-end refresh reads fresh state even where
// no watcher runs, long enough to cover the burst. Errors cache too: a
// broken repo shouldn't be re-probed per request.
const REPO_STATUS_TTL_MS = Number(process.env.FS_GIT_STATUS_TTL_MS ?? 3_000);
const statusCache = new Map<string, { at: number; value: Promise<RepoStatus> }>();

/**
 * Drop every cached repo status — Phase W's watcher bell (W.2): disk just
 * changed, so a bell-triggered refetch must read statuses fresh instead of
 * being served a pre-change answer still inside its TTL. Global rather than
 * per-session-root on purpose: a change often lands in a repo shared across
 * views, re-statusing is one queued subprocess per repo, and the cache
 * refills on the very next listing.
 */
export function invalidateRepoStatusCache(): void {
  statusCache.clear();
  // The trust scan is config-derived, and `.git/config` changing is exactly
  // the kind of disk change that rings the bell — so an edited config is
  // re-read on the same signal rather than living on until restart.
  invalidateRepoTrustCache();
}

export function repoStatus(repoRoot: string): Promise<RepoStatus> {
  const hit = statusCache.get(repoRoot);
  if (hit && Date.now() - hit.at < REPO_STATUS_TTL_MS) return hit.value;
  // Keys are real repo roots found on disk, so growth is naturally bounded —
  // this guard just caps the pathological case (repos created and deleted
  // under a long-lived daemon).
  if (statusCache.size > 64) statusCache.clear();
  const value = enqueue(async () => {
    const r = await runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--ignored"]);
    if (!r.ok) return r.notGit ? { notGit: true as const } : { error: gitErr("status", r) };
    return parseStatusIgnoredZ(String(r.stdout));
  });
  // W.H2: the TTL clock starts when the answer ARRIVES, not when it was
  // asked for. In flight = always fresh (at: Infinity), so late callers
  // coalesce onto the running call — a request-time stamp would expire
  // mid-flight whenever git (plus its queue time) outran the TTL, and every
  // expiry would enqueue yet another child behind the slow one, a backlog
  // that feeds itself. The settle stamp covers rejections too.
  const entry = { at: Number.POSITIVE_INFINITY, value };
  const stamp = () => {
    entry.at = Date.now();
  };
  value.then(stamp, stamp);
  statusCache.set(repoRoot, entry);
  return value;
}

/** Any strict ancestor prefix of `p` present in `set` ("a/b/c" → "a/b", "a"). */
const underAny = (p: string, set: Set<string>): boolean => {
  for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/")) {
    p = p.slice(0, i);
    if (set.has(p)) return true;
  }
  return false;
};

/**
 * Decorate one directory's raw entries with the repo's view: ignored entries
 * DROP (the repo's own ignore rules, honored — E2.2's known interim closed),
 * statuses attach (a file's own record; a wholly-untracked dir shows U, and
 * so does anything beneath one — porcelain's collapse means those children
 * have no record of their own), and deleted children MERGE in (they exist in
 * status but not on disk; the whole-tree view kept them visible, so does
 * this). `dirRel` is the listed dir's repo-root-relative path, "" at the
 * repo root. Pure — exported for the Tier-1 pin; caller sorts and caps.
 */
export function decorateGitDir(
  raw: FsDirEntry[],
  dirRel: string,
  st: RepoStatusData,
): FsDirEntry[] {
  const key = (name: string) => (dirRel ? `${dirRel}/${name}` : name);
  const out: FsDirEntry[] = [];
  const names = new Set<string>();
  for (const e of raw) {
    const p = key(e.name);
    if (st.ignored.has(p) || underAny(p, st.ignored)) continue;
    names.add(e.name);
    const status =
      st.files.get(p) ??
      (st.untrackedDirs.has(p) || underAny(p, st.untrackedDirs) ? "U" : undefined);
    out.push({ ...e, ...(status ? { status } : {}) });
  }
  for (const [p, c] of st.files) {
    if (c !== "D") continue;
    const cut = p.lastIndexOf("/");
    if ((cut === -1 ? "" : p.slice(0, cut)) !== dirRel) continue;
    const name = p.slice(cut + 1);
    if (!names.has(name)) out.push({ name, kind: "file", status: "D" });
  }
  return out;
}
