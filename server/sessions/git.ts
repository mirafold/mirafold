// The Explorer/Changes git layer: one-shot, bounded `git` invocations for the
// session root — the tracked+untracked tree with change status behind
// `fs_list`, the complete changed set behind `fs_changes`, and HEAD's version
// of a file behind `fs_diff`. Every
// call is execFile (no shell), timeboxed, buffer-capped, and settles to a
// TYPED result — "not a repo" and "no git binary" are ordinary degrade
// values, never throws, so a non-repo workspace falls back to the walk.
// Nothing here touches the wire or the registry; connection.ts composes.

import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import type { FsChangeRepo, FsDirEntry, FsEntry } from "../protocol";
import { GIT_TIMEOUT_MS, invalidateRepoTrustCache, repoTrust } from "./git-trust";
// The walk's caps, shared (fs-explorer.ts) — both replies ride the same wire.
import {
  contentRevision,
  FS_TREE_MAX_ENTRIES,
  FS_TREE_MAX_PATH_BYTES,
  readWorkspaceDiffEntry,
} from "./fs-explorer";
import { envInt } from "../env";
import { isSecretFile } from "../security/permissions";

// `git show` of a big blob is the largest legitimate output; the caller caps
// content for the wire — this only bounds process memory.
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

// CR.1's complete change-set bounds. Unlike gitTree, this query carries only
// changed paths, but a generated/vendor churn burst can still be enormous.
// Count and UTF-8 bytes cap the reply; repo/node caps bound Projects-root
// discovery before any git child runs. All four can be tightened in tests.
const FS_CHANGES_MAX_ENTRIES = envInt("FS_CHANGES_MAX_ENTRIES", 4_000);
const FS_CHANGES_MAX_PATH_BYTES = envInt("FS_CHANGES_MAX_PATH_BYTES", 400_000);
const FS_CHANGES_MAX_REPOS = envInt("FS_CHANGES_MAX_REPOS", 64);
const FS_CHANGES_MAX_DISCOVERY_NODES = envInt("FS_CHANGES_MAX_DISCOVERY_NODES", 40_000);

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
): { files: Map<string, string>; untrackedDirs: Set<string>; records: Map<string, string[]> } => {
  const files = new Map<string, string>();
  const untrackedDirs = new Set<string>();
  const records = new Map<string, string[]>();
  const remember = (p: string, xy: string) => {
    const current = records.get(p);
    if (current) current.push(xy);
    else records.set(p, [xy]);
  };
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 4) continue; // trailing empty field / junk
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      const from = fields[++i]; // the second field of this record
      remember(p, xy);
      files.set(p, "A");
      // Rename: the source is gone → D. Copy: the source still exists,
      // unchanged — marking it D would lie about a file sitting on disk.
      if (xy.includes("R") && from) {
        remember(from, xy);
        files.set(from, "D");
      }
      continue;
    }
    if (xy === "??") {
      if (p.endsWith("/")) untrackedDirs.add(p.slice(0, -1));
      else {
        remember(p, xy);
        files.set(p, "U");
      }
    } else {
      remember(p, xy);
      if (xy.includes("D")) files.set(p, "D");
      else if (xy.includes("A")) files.set(p, "A");
      else files.set(p, "M");
    }
  }
  return { files, untrackedDirs, records };
};

type WorkingTreeEntry =
  | { kind: "absent" }
  | { kind: "content"; revision: string }
  | { kind: "unverified" };

/** Read the Git entry itself, not a symlink target. This is used only for
 * exceptional index states that porcelain cannot collapse into the promised
 * HEAD-versus-working-tree answer. Ordinary change enumeration remains one
 * status subprocess and does not read every changed file. */
const readWorkingTreeEntry = (root: string, rel: string): WorkingTreeEntry => {
  if (!cleanRelPath(rel)) return { kind: "unverified" };
  const result = readWorkspaceDiffEntry(root, rel, {
    revision: true,
    revisionCapBytes: GIT_MAX_BUFFER,
  });
  if ("absent" in result) return { kind: "absent" };
  if ("error" in result || !result.revision) return { kind: "unverified" };
  return { kind: "content", revision: result.revision };
};

type NetChange = { status?: string; verified: boolean };

const isDotenvPath = (rel: string): boolean => {
  const base = path.posix.basename(rel);
  return base.endsWith(".env") || base.includes(".env.");
};

const netChangeAgainstHead = async (
  root: string,
  rel: string,
  fallback?: string,
): Promise<NetChange> => {
  // Listing a secret path is permitted, but Changes must not inspect its
  // contents merely to repair an unusual index flag. Keep porcelain's answer
  // when one exists and mark an otherwise-hidden flagged path incomplete.
  if (isSecretFile(rel) || isDotenvPath(rel)) {
    return { status: fallback, verified: false };
  }
  // Start the subprocess first, then read the tree while it runs — the same
  // interleaving the old Promise.all had, without dressing a synchronous
  // read up as a concurrent task.
  const headPromise = gitShowHead(root, rel);
  const working = readWorkingTreeEntry(root, rel);
  const head = await headPromise;
  if ("error" in head || "notGit" in head || working.kind === "unverified") {
    return { status: fallback, verified: false };
  }
  if (!("content" in head)) {
    return working.kind === "content"
      ? { status: fallback === "U" ? "U" : "A", verified: true }
      : { verified: true };
  }
  if (working.kind !== "content") return { status: "D", verified: true };
  return {
    ...(contentRevision(head.content) === working.revision ? {} : { status: "M" }),
    verified: true,
  };
};

// H is an ordinary cached path. Lowercase tags are assume-unchanged;
// S is skip-worktree. Other non-H tags are exceptional enough that an
// exact comparison is safer than trusting an index-oriented label. The tag
// rides along: for S/h-style entries an ABSENT working file is the state
// the user configured (sparse checkout, assume-unchanged), not a deletion.
const exceptionalTrackedPaths = (out: string): { rel: string; tag: string }[] =>
  out
    .split("\0")
    .filter((record) => record.length >= 3 && record[1] === " " && record[0] !== "H")
    .map((record) => ({ rel: record.slice(2), tag: record[0] }));

// One direct HEAD-vs-working comparison costs a `git show` subprocess plus a
// bounded file read. A pathological pile of exceptional paths (a huge
// mid-merge, an index full of odd flags) must not turn one fs_changes reply
// into minutes of sequential subprocesses — beyond this many, the answer is
// honestly incomplete instead (bughunt 2026-08-13).
const MAX_NET_COMPARISONS = 200;

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
export async function gitTree(
  root: string,
  caps: { maxEntries?: number; maxPathBytes?: number } = {},
): Promise<GitTree> {
  const maxEntries = caps.maxEntries ?? FS_TREE_MAX_ENTRIES;
  const maxPathBytes = caps.maxPathBytes ?? FS_TREE_MAX_PATH_BYTES;
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
    const relBytes = Buffer.byteLength(rel, "utf8");
    if (entries.length >= maxEntries || pathBytes + relBytes > maxPathBytes) {
      truncated = true;
      return;
    }
    const status = statusByRel.get(rel) ?? (inUntrackedDir(rel) ? "U" : undefined);
    entries.push({ path: rel, ...(status ? { status } : {}) });
    pathBytes += relBytes;
  };
  for (const rel of String(ls.stdout).split("\0")) push(rel);
  // Status-only paths: staged deletes (and rename sources) missing from
  // ls-files. Sorted merge keeps the reply deterministic.
  for (const rel of [...statusByRel.keys()].sort()) push(rel);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, truncated };
}

type GitChanges =
  | { entries: FsEntry[]; truncated: boolean }
  | { notGit: true }
  | { error: string };

/**
 * Changed FILES only for `root`'s repo scope. `--untracked-files=all` is
 * load-bearing: ordinary untracked directories expand to their files rather
 * than arriving as a phantom `dir/` entry. Porcelain -z paths are repo-root
 * relative, so the same show-prefix reconciliation as gitTree keeps a session
 * rooted at a subdirectory from naming dirt above its scope.
 */
export async function gitChanges(
  root: string,
  caps: { maxEntries?: number; maxPathBytes?: number } = {},
): Promise<GitChanges> {
  const maxEntries = caps.maxEntries ?? FS_CHANGES_MAX_ENTRIES;
  const maxPathBytes = caps.maxPathBytes ?? FS_CHANGES_MAX_PATH_BYTES;
  const trust = await repoTrust(root);
  if (trust.unscannable) {
    return { error: "repository Git settings could not be inspected safely" };
  }
  const [status, prefixRes, trackedFlags] = await Promise.all([
    runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
    runGit(root, ["rev-parse", "--show-prefix"]),
    runGit(root, ["ls-files", "-v", "-z", "--", "."]),
  ]);
  if (!status.ok) return status.notGit ? { notGit: true } : { error: gitErr("status", status) };
  if (!prefixRes.ok) return { error: gitErr("rev-parse", prefixRes) };
  if (!trackedFlags.ok) return { error: gitErr("ls-files", trackedFlags) };
  const prefix = String(prefixRes.stdout).trim();
  const parsed = parseStatusZ(String(status.stdout));
  const statusByRel = new Map<string, string>();
  const exceptional = new Set<string>();
  for (const [repoPath, statusChar] of parsed.files) {
    const rel = prefix === "" ? repoPath : repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : "";
    if (!rel) continue;
    statusByRel.set(rel, statusChar);
    const records = parsed.records.get(repoPath) ?? [];
    // Add-like then deleted (AD, and the rename/copy destinations RD/CD —
    // parseStatusZ collapses R/C to A only in `files`, so the raw tag is
    // matched here; bughunt: RD produced a phantom "A" for a path absent
    // from both HEAD and the working tree) nets to nothing-or-something
    // only a direct comparison can answer.
    if (
      records.length > 1 ||
      records.some((xy) => /[ARC]/.test(xy) && xy.includes("D"))
    ) {
      exceptional.add(rel);
    }
  }
  // Skip-worktree / assume-unchanged tags, for the absence rule below.
  const configuredAbsence = new Set<string>();
  for (const { rel, tag } of exceptionalTrackedPaths(String(trackedFlags.stdout))) {
    if (!rel) continue;
    exceptional.add(rel);
    if (tag === "S" || tag === tag.toLowerCase()) configuredAbsence.add(rel);
  }

  // Porcelain describes index + worktree state. For the exceptional cases
  // where that differs from the product's actual promise, compare the path's
  // current bytes directly with HEAD and replace/omit the label accordingly.
  let netStateIncomplete = false;
  let comparisons = 0;
  for (const rel of [...exceptional].sort()) {
    // Sparse checkouts skip-worktree every excluded file and legitimately
    // leave it off disk — that absence is the configured state, not a
    // deletion (bughunt: a clean sparse monorepo reported every excluded
    // file "D", one git-show subprocess each). The cheap existence read
    // answers it without ever spawning git.
    if (configuredAbsence.has(rel) && readWorkingTreeEntry(root, rel).kind === "absent") {
      statusByRel.delete(rel);
      continue;
    }
    if (++comparisons > MAX_NET_COMPARISONS) {
      netStateIncomplete = true;
      break;
    }
    const net = await netChangeAgainstHead(root, rel, statusByRel.get(rel));
    if (!net.verified) netStateIncomplete = true;
    if (net.status) statusByRel.set(rel, net.status);
    else statusByRel.delete(rel);
  }

  const entries: FsEntry[] = [];
  let pathBytes = 0;
  // -uall should make this empty. If a git implementation still collapses a
  // special nested repository, omit the non-file prefix and say the answer is
  // incomplete rather than presenting a directory as reviewable code.
  // "Incomplete" is wider than the wire's `truncated` name: capped output,
  // unverified net state, or a collapsed untracked dir all raise it.
  let incomplete = parsed.untrackedDirs.size > 0 || netStateIncomplete;
  for (const [rel, statusChar] of [...statusByRel.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const bytes = Buffer.byteLength(rel, "utf8");
    if (entries.length >= maxEntries || pathBytes + bytes > maxPathBytes) {
      incomplete = true;
      break;
    }
    entries.push({ path: rel, status: statusChar });
    pathBytes += bytes;
  }
  return { entries, truncated: incomplete };
}

type RepoDiscovery =
  | { roots: string[]; truncated: boolean }
  | { error: string };

const gitAdminDirLooksValid = (adminDir: string): boolean => {
  try {
    const head = lstatSync(path.join(adminDir, "HEAD"));
    if (!head.isFile()) return false;
    // Ordinary repositories own objects directly. Linked worktrees point at
    // a per-worktree admin dir whose `commondir` names the shared object dir.
    try {
      if (lstatSync(path.join(adminDir, "objects")).isDirectory()) return true;
    } catch {
      // Linked worktrees legitimately have no local objects directory.
    }
    try {
      return lstatSync(path.join(adminDir, "commondir")).isFile();
    } catch {
      return false;
    }
  } catch {
    return false;
  }
};

/** A marker is a repository boundary only when it has Git's minimum admin
 * shape. Mere `.git` existence is insufficient: stale empty directories and
 * malformed gitdir files must not hide valid repositories below/above them. */
const hasValidGitMarker = (dir: string): boolean => {
  const marker = path.join(dir, ".git");
  let stat;
  try {
    stat = lstatSync(marker);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return gitAdminDirLooksValid(marker);
  if (!stat.isFile() || stat.size > 4_096) return false;
  try {
    const match = /^gitdir:\s*(.+?)\s*$/i.exec(readFileSync(marker, "utf8"));
    if (!match) return false;
    const adminDir = path.resolve(dir, match[1]);
    return gitAdminDirLooksValid(adminDir);
  } catch {
    return false;
  }
};

/**
 * Find repositories BELOW a non-repo session root. Symlinks are never
 * followed. Once a repo is found its contents are not scanned: Git owns that
 * subtree, while the discovery walk continues through sibling directories.
 * This is the Projects-root shape; a session already inside a repo bypasses
 * this walk entirely in workspaceChanges below.
 */
export function discoverNestedRepoRoots(
  root: string,
  caps: { maxRepos?: number; maxNodes?: number } = {},
): RepoDiscovery {
  const maxRepos = caps.maxRepos ?? FS_CHANGES_MAX_REPOS;
  const maxNodes = caps.maxNodes ?? FS_CHANGES_MAX_DISCOVERY_NODES;
  const pending = [path.resolve(root)];
  let nextPending = 0;
  const roots: string[] = [];
  let nodes = 0;
  let truncated = false;
  let stopped = false;
  while (nextPending < pending.length && !stopped) {
    const dir = pending[nextPending++];
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      if (dir === path.resolve(root)) return { error: "the session workspace is not readable" };
      // An unreadable descendant makes discovery incomplete, but remaining
      // siblings can still be useful. Keep scanning and say the answer was
      // truncated rather than silently presenting it as complete.
      truncated = true;
      continue;
    }
    if (hasValidGitMarker(dir)) {
      if (roots.length >= maxRepos) {
        truncated = true;
        stopped = true;
        continue;
      }
      roots.push(dir);
      continue;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (!child.isDirectory() || child.name === ".git" || child.name === "node_modules") continue;
      if (++nodes > maxNodes) {
        truncated = true;
        stopped = true;
        break;
      }
      pending.push(path.join(dir, child.name));
    }
  }
  roots.sort();
  return { roots, truncated };
}

export type WorkspaceChanges =
  | { repos: FsChangeRepo[]; truncated: boolean }
  | { error: string };

/**
 * The complete session-scoped change set. A normal repo (including a session
 * rooted at one of its subdirectories) is one group rooted at "". A parent
 * directory outside Git discovers bounded nested repos and maps every path
 * back to the immutable session root for the existing fs_diff jail.
 */
export async function workspaceChanges(
  root: string,
  caps: {
    maxEntries?: number;
    maxPathBytes?: number;
    maxRepos?: number;
    maxDiscoveryNodes?: number;
  } = {},
): Promise<WorkspaceChanges> {
  const maxEntries = caps.maxEntries ?? FS_CHANGES_MAX_ENTRIES;
  const maxPathBytes = caps.maxPathBytes ?? FS_CHANGES_MAX_PATH_BYTES;
  const sessionRoot = path.resolve(root);

  // Git, not the mere presence of an ancestor `.git` entry, decides whether
  // this workspace is one repository scope. A stale/malformed ancestor marker
  // is not a repository; treating it as one would suppress valid nested repos.
  // gitChanges already reconciles a real subdirectory session to that repo's
  // root while keeping the returned paths session-relative.
  const direct = await gitChanges(sessionRoot, { maxEntries, maxPathBytes });
  if ("entries" in direct) {
    return {
      repos: [
        {
          root: "",
          entries: direct.entries,
          ...(direct.truncated ? { truncated: true } : {}),
        },
      ],
      truncated: direct.truncated,
    };
  }
  if ("error" in direct) {
    return { repos: [{ root: "", entries: [], error: direct.error }], truncated: false };
  }

  const discovery = discoverNestedRepoRoots(sessionRoot, {
    maxRepos: caps.maxRepos,
    maxNodes: caps.maxDiscoveryNodes,
  });
  if ("error" in discovery) return discovery;

  const repos: FsChangeRepo[] = [];
  let totalEntries = 0;
  let totalPathBytes = 0;
  let truncated = discovery.truncated;
  for (const scopeRoot of discovery.roots) {
    if (totalEntries >= maxEntries || totalPathBytes >= maxPathBytes) {
      truncated = true;
      break;
    }
    const repoLabel = path.relative(sessionRoot, scopeRoot).split(path.sep).join("/");
    const repoLabelBytes = Buffer.byteLength(repoLabel, "utf8");
    if (totalPathBytes + repoLabelBytes > maxPathBytes) {
      truncated = true;
      break;
    }
    totalPathBytes += repoLabelBytes;
    const result = await gitChanges(scopeRoot, {
      maxEntries: maxEntries - totalEntries,
      maxPathBytes: maxPathBytes - totalPathBytes,
    });
    if ("notGit" in result) {
      truncated = true;
      repos.push({ root: repoLabel, entries: [], error: "not a git repository" });
      continue;
    }
    if ("error" in result) {
      repos.push({ root: repoLabel, entries: [], error: result.error });
      continue;
    }
    const entries: FsEntry[] = [];
    let groupTruncated = result.truncated;
    for (const entry of result.entries) {
      const sessionPath = repoLabel ? `${repoLabel}/${entry.path}` : entry.path;
      const bytes = Buffer.byteLength(sessionPath, "utf8");
      if (totalEntries >= maxEntries || totalPathBytes + bytes > maxPathBytes) {
        groupTruncated = true;
        truncated = true;
        break;
      }
      entries.push({ ...entry, path: sessionPath });
      totalEntries += 1;
      totalPathBytes += bytes;
    }
    if (groupTruncated) truncated = true;
    repos.push({
      root: repoLabel,
      entries,
      ...(groupTruncated ? { truncated: true } : {}),
    });
  }
  return { repos, truncated };
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
export const findRepoRoot = (
  realDir: string,
  entryExists: (candidate: string) => boolean = existsSync,
): string | null => {
  let dir = realDir;
  // Keyed on function IDENTITY, deliberately: marker validation reads the
  // REAL filesystem (hasValidGitMarker → lstat/readFile) and cannot be
  // virtualized through `entryExists`, so it runs only when the caller left
  // the default oracle in place. Every production call site does; the pure-
  // walk unit tests inject a jailed oracle over fixtures that are invalid as
  // real repos, and validation would flip them. Beware: passing a WRAPPER
  // around existsSync (caching, jailing) silently disables validation too.
  const validateMarker = entryExists === existsSync;
  for (;;) {
    if (
      entryExists(path.join(dir, ".git")) &&
      (!validateMarker || hasValidGitMarker(dir))
    ) {
      return dir;
    }
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
const REPO_STATUS_TTL_MS = envInt("FS_GIT_STATUS_TTL_MS", 3_000);
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
