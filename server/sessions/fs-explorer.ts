// The Explorer's server half (Phase E.1): the shell's read-only view of a
// session's working tree — the tree walk behind `fs_list` and the file read
// behind `fs_read`. Everything resolves through `inside()`'s realpath
// containment against the session root (a planted symlink can't walk out)
// with the secret-env denial layered on top. Results are per-viewport
// replies; nothing here is broadcast, buffered, or replayed. Deliberately
// synchronous (the workspace_ls precedent): every walk and read is capped,
// so no call holds the event loop meaningfully — and sync means the reply
// can never race a closed socket.

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { FsDirEntry, FsEntry } from "../protocol";
import { inside } from "./actions";
import { isSecretFile } from "../security/permissions";
import { envInt } from "../env";

// Walk caps. The whole fs_tree reply must stay far under MAX_WS_PAYLOAD
// (1 MB inbound; replies should honor the same order of magnitude — the
// relay envelope allows 1.5×) even on a monorepo, and JSON escaping can
// inflate exotic filenames — so the cap is on entry COUNT and path BYTES
// both. Honest: `truncated: true`, never a silent cut. Exported: git.ts's
// tree reply shares exactly these caps.
export const FS_TREE_MAX_ENTRIES = envInt("FS_TREE_MAX_ENTRIES", 4_000);
export const FS_TREE_MAX_PATH_BYTES = envInt("FS_TREE_MAX_PATH_BYTES", 400_000);
// Bounds the WALK's cost, not just the reply. The entry/byte caps count only
// FILES, so a tree of many (mostly empty) directories would be walked in full
// — the file cap never trips. This caps total nodes VISITED (files + dirs), so
// the synchronous walk can't block the event loop on a pathological non-git
// workspace (the git path is bounded separately by its subprocess limits).
// Well above the entry cap: real projects hit files first (2026-07-24 audit).
const FS_TREE_MAX_NODES = envInt("FS_TREE_MAX_NODES", 40_000);

// Directories nobody browses that would drown the tree (and blow the caps
// instantly). E.2's git view gets this pruning for free via .gitignore;
// this is the non-repo walk's equivalent floor.
const SKIP_DIRS = new Set([".git", "node_modules"]);

// Per-directory caps (E2.1). One fs_dir reply must stay far under the wire
// payload bounds even on a pathological flat directory — capped on entry
// COUNT and NAME BYTES both (names, not paths: the reply carries names).
// Strictly tighter than the whole-tree caps, since the unit is one readdir.
const FS_DIR_MAX_ENTRIES = envInt("FS_DIR_MAX_ENTRIES", 2_000);
const FS_DIR_MAX_NAME_BYTES = envInt("FS_DIR_MAX_NAME_BYTES", 200_000);

// A file read is bounded twice: the sniff window that decides binary vs
// text, and the content cap — same size and same honesty contract as the
// tool_result cap (TOOL_OUTPUT_CAP_BYTES), but applied via bounded fd reads
// so a multi-GB file never gets loaded to be truncated.
const SNIFF_BYTES = 8_192;
const FS_FILE_CAP_BYTES = envInt("FS_FILE_CAP_BYTES", 64_000);

/** NUL in the sniff window = binary. E.2 applies the same rule to git blobs
 *  (the fd path below sniffs its own window the same way). */
export const sniffBinary = (buf: Buffer): boolean =>
  buf.subarray(0, Math.min(buf.length, SNIFF_BYTES)).includes(0);

/** Cap an in-memory blob (a `git show` result) to the file cap with the same
 *  honesty contract as the fd read path: lossy decode, byte-true elision. */
export function capBuffer(buf: Buffer): { text: string; truncatedBytes?: number } {
  const kept = buf.subarray(0, Math.min(buf.length, FS_FILE_CAP_BYTES));
  const text = new TextDecoder().decode(kept);
  return { text, ...(buf.length > kept.length ? { truncatedBytes: buf.length - kept.length } : {}) };
}

export type TreeResult = { entries: FsEntry[]; truncated: boolean } | { error: string };

export type DirResult = { entries: FsDirEntry[]; truncated: boolean } | { error: string };

export type FileResult =
  | { content: string; size: number; truncatedBytes?: number }
  | { binary: true; size: number }
  | { error: string };

/**
 * Walk the session root and return every FILE as a root-relative /-separated
 * path, alphabetical within each directory. Symlinks are leaves — never
 * followed, even when they point at directories, so a link can't graft an
 * outside tree (or a cycle) into the listing. Unreadable subdirectories are
 * skipped, not fatal; an unreadable ROOT is the error case.
 */
export function listTree(
  root: string,
  caps: { maxEntries?: number; maxPathBytes?: number; maxNodes?: number } = {},
): TreeResult {
  const maxEntries = caps.maxEntries ?? FS_TREE_MAX_ENTRIES;
  const maxPathBytes = caps.maxPathBytes ?? FS_TREE_MAX_PATH_BYTES;
  const maxNodes = caps.maxNodes ?? FS_TREE_MAX_NODES;
  const realRoot = inside(root, ".");
  if (!realRoot) return { error: "the session workspace is not readable" };
  const entries: FsEntry[] = [];
  let pathBytes = 0;
  let nodesSeen = 0;
  let truncated = false;
  const walk = (dir: string, relPrefix: string) => {
    if (truncated) return;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subdir: skip it, keep the rest of the tree
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      if (truncated) return;
      // Every dirent counts toward the walk budget — directories included, so
      // an empty-dir-heavy tree can't be walked without bound (audit finding).
      if (++nodesSeen > maxNodes) {
        truncated = true;
        return;
      }
      const rel = relPrefix ? `${relPrefix}/${d.name}` : d.name;
      // Dirent types come from lstat semantics: a symlink-to-dir reports as
      // a symlink (not a directory), which is exactly the leaf rule.
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(path.join(dir, d.name), rel);
        continue;
      }
      const relBytes = Buffer.byteLength(rel, "utf8");
      if (entries.length >= maxEntries || pathBytes + relBytes > maxPathBytes) {
        truncated = true;
        return;
      }
      entries.push({ path: rel });
      pathBytes += relBytes;
    }
  };
  walk(realRoot, "");
  return { entries, truncated };
}

/**
 * The raw readdir behind the lazy tree's fetch unit: jail, kinds, and the
 * SKIP_DIRS floor — but no sort, no caps, and the resolved real path kept.
 * Split out (E2.3) so the git layer can decorate or filter a listing BEFORE
 * the caps apply — a dropped ignored entry must free its cap budget, and a
 * merged deleted entry must count against it. `rel` is the client's requested
 * root-relative path ("" or "." = the root). Symlinks are leaves by kind
 * (lstat semantics: a symlink-to-dir reports `symlink`, not `dir`).
 */
export function readDirRaw(
  root: string,
  rel: string,
): { real: string; all: FsDirEntry[] } | { error: string } {
  const real = inside(root, rel === "" ? "." : rel);
  if (!real) return { error: "path is outside the session workspace" };
  let dirents;
  try {
    dirents = readdirSync(real, { withFileTypes: true });
  } catch (err) {
    return {
      error:
        (err as NodeJS.ErrnoException).code === "ENOTDIR"
          ? "path is not a directory"
          : "directory is not readable",
    };
  }
  const kindOf = (d: (typeof dirents)[number]): FsDirEntry["kind"] =>
    // Order matters: isDirectory() is false for a symlink-to-dir (lstat
    // semantics), so the symlink check needn't come first — but a FIFO or
    // socket lands as `file`, same as the walk lists it (refused at read time).
    d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : "file";
  const all = dirents
    .filter((d) => !(d.isDirectory() && SKIP_DIRS.has(d.name)))
    .map((d) => ({ name: d.name, kind: kindOf(d) }));
  return { real, all };
}

/**
 * Order and cap one directory's entries for the wire. Directories sort
 * before files, alphabetical within each group — so when a cap trips, files
 * are what get cut and the tree stays navigable.
 */
export function sortAndCapDir(
  all: FsDirEntry[],
  caps: { maxEntries?: number; maxNameBytes?: number } = {},
): { entries: FsDirEntry[]; truncated: boolean } {
  const maxEntries = caps.maxEntries ?? FS_DIR_MAX_ENTRIES;
  const maxNameBytes = caps.maxNameBytes ?? FS_DIR_MAX_NAME_BYTES;
  const rank = (k: FsDirEntry["kind"]) => (k === "dir" ? 0 : 1);
  const sorted = [...all].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const entries: FsDirEntry[] = [];
  let nameBytes = 0;
  let truncated = false;
  for (const e of sorted) {
    nameBytes += Buffer.byteLength(e.name, "utf8");
    if (entries.length >= maxEntries || nameBytes > maxNameBytes) {
      truncated = true;
      break;
    }
    entries.push(e);
  }
  return { entries, truncated };
}

/**
 * List ONE directory's children — the lazy tree's fetch unit (E2.1), plain
 * (no git view): readDirRaw + sortAndCapDir. The SKIP_DIRS floor carries
 * over: a `.git`/`node_modules` DIRECTORY is omitted, exactly as the
 * whole-tree walk prunes it. The tests' composition of the two exported
 * halves — production (fs-handlers.ts) composes them directly.
 */
export function listDir(
  root: string,
  rel: string,
  caps: { maxEntries?: number; maxNameBytes?: number } = {},
): DirResult {
  const raw = readDirRaw(root, rel);
  if ("error" in raw) return raw;
  return sortAndCapDir(raw.all, caps);
}

/**
 * Read one workspace file for the viewer: jailed, secret-denied, binary-
 * sniffed, cap-honest. `rel` is the client's requested root-relative path —
 * a REQUEST, never trusted: it resolves through `inside()` or not at all.
 */
export function readWorkspaceFile(root: string, rel: string): FileResult {
  const real = inside(root, rel);
  if (!real) return { error: "path is outside the session workspace" };
  if (isSecretFile(real)) return { error: "environment files are never readable here" };
  let st;
  try {
    st = statSync(real);
  } catch {
    return { error: "file is not readable" };
  }
  if (st.isDirectory()) return { error: "path is a directory" };
  // A FIFO/socket would stall a read and, with it, the daemon's event loop —
  // the same lesson as the cwd-handoff lstat gate.
  if (!st.isFile()) return { error: "not a regular file" };
  const size = st.size;
  let fd;
  try {
    fd = openSync(real, "r");
  } catch {
    return { error: "file is not readable" };
  }
  try {
    const sniffLen = Math.min(size, SNIFF_BYTES);
    const sniff = Buffer.alloc(sniffLen);
    const sniffed = readSync(fd, sniff, 0, sniffLen, 0);
    if (sniff.subarray(0, sniffed).includes(0)) return { binary: true, size };
    const keptLen = Math.min(size, FS_FILE_CAP_BYTES);
    const buf = Buffer.alloc(keptLen);
    let read = 0;
    while (read < keptLen) {
      const n = readSync(fd, buf, read, keptLen - read, read);
      if (n <= 0) break; // file shrank under us — keep what's real
      read += n;
    }
    // Lossy decode: invalid UTF-8 (and a cap-split trailing char) becomes
    // U+FFFD rather than an error — same behavior as capOutput's slice.
    const content = new TextDecoder().decode(buf.subarray(0, read));
    return { content, size, ...(size > read ? { truncatedBytes: size - read } : {}) };
  } finally {
    closeSync(fd);
  }
}
