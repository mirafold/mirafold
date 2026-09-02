// The folder tree's server half: the shell's read-only view of a
// session's working tree — the tree walk behind `fs_list` and the file read
// behind `fs_read`. Everything resolves through `inside()`'s realpath
// containment against the session root (a planted symlink can't walk out)
// with the secret-env denial layered on top. Results are per-viewport
// replies; nothing here is broadcast, buffered, or replayed. Deliberately
// synchronous (the workspace_ls precedent): every walk and read is capped,
// so no call holds the event loop meaningfully — and sync means the reply
// can never race a closed socket.

import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  readdirSync,
  readSync,
  type Dirent,
} from "node:fs";
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
// Well above the entry cap: real projects hit files first.
const FS_TREE_MAX_NODES = envInt("FS_TREE_MAX_NODES", 40_000);

// Directories nobody browses that would drown the tree (and blow the caps
// instantly). The git view gets this pruning for free via .gitignore;
// this is the non-repo walk's equivalent floor.
const SKIP_DIRS = new Set([".git", "node_modules"]);

// Per-directory caps. One fs_dir reply must stay far under the wire
// payload bounds even on a pathological flat directory — capped on entry
// COUNT and NAME BYTES both (names, not paths: the reply carries names).
// Strictly tighter than the whole-tree caps, since the unit is one readdir.
const FS_DIR_MAX_ENTRIES = envInt("FS_DIR_MAX_ENTRIES", 2_000);
const FS_DIR_MAX_NAME_BYTES = envInt("FS_DIR_MAX_NAME_BYTES", 200_000);
// Git decoration can discard ignored entries before the reply caps apply, so
// the raw scan needs headroom beyond FS_DIR_MAX_ENTRIES. It still needs a hard
// ceiling of its own: readdirSync would otherwise allocate every name in a
// pathological flat directory before either reply cap saw it.
const FS_DIR_MAX_SCAN_ENTRIES = 10_000;

// A file read is bounded twice: the sniff window that decides binary vs
// text, and the content cap — same size and same honesty contract as the
// tool_result cap (TOOL_OUTPUT_CAP_BYTES), but applied via bounded fd reads
// so a multi-GB file never gets loaded to be truncated.
const SNIFF_BYTES = 8_192;
const FS_FILE_CAP_BYTES = envInt("FS_FILE_CAP_BYTES", 64_000);
// Review markers must name actual content, not a path or a timestamp.
// Hashing is deliberately opt-in (only fs_diff asks) and bounded to 1 MB so
// four allowed requests per second cannot turn synchronous file hashing into
// an event-loop denial of service. Larger files remain viewable with the
// existing honest truncation note, but the client receives no revision and
// therefore cannot claim they were reviewed.
const FS_FILE_REVISION_CAP_BYTES = 1024 * 1024;
// Per-daemon salt keeps a revision useful only as an equality token. A remote
// viewport that may view a filename but not its binary bytes must not receive
// a reusable public content fingerprint.
const FILE_REVISION_KEY = randomBytes(32);

/** NUL in the sniff window = binary. The same rule applies to git blobs
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
  | { content: string; size: number; truncatedBytes?: number; revision?: string }
  | { binary: true; size: number; revision?: string }
  | { error: string };

type DiffEntryResult = FileResult | { absent: true };

/** A compact, opaque identity for exact bytes. This is a correctness key,
 * not exposed file content; keyed SHA-256 makes a stale reviewed marker
 * depend on the bytes without publishing a reusable content fingerprint. */
export const contentRevision = (content: Uint8Array): string =>
  `revision:v1:${createHmac("sha256", FILE_REVISION_KEY).update(content).digest("hex")}`;

/** HEAD + working-tree identity for one diff. Length-framed hashes keep the
 * two sides unambiguous without retaining either file in browser memory. */
export const diffContentRevision = (before: Uint8Array, afterRevision: string): string =>
  `revision:v1:${createHmac("sha256", FILE_REVISION_KEY)
    .update(String(before.byteLength))
    .update("\0")
    .update(before)
    .update("\0")
    .update(afterRevision)
    .digest("hex")}`;

export const reviewDiffRevision = (
  before: Uint8Array,
  afterRevision: string | undefined,
  maxBytes = FS_FILE_REVISION_CAP_BYTES,
): string | undefined =>
  afterRevision && before.byteLength <= maxBytes
    ? diffContentRevision(before, afterRevision)
    : undefined;

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
      // an empty-dir-heavy tree can't be walked without bound.
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
 * The raw directory scan behind the lazy tree's fetch unit: jail, kinds, the
 * SKIP_DIRS floor, and a work cap, with the resolved real path kept. Split out
 * so the git layer can decorate or filter a listing BEFORE the tighter reply
 * caps apply — a dropped ignored entry must free its cap budget, and a merged
 * deleted entry must count against it. `rel` is the client's requested
 * root-relative path ("" or "." = the root). Symlinks are leaves by kind
 * (lstat semantics: a symlink-to-dir reports `symlink`, not `dir`).
 */
export function readDirRaw(
  root: string,
  rel: string,
  maxScanEntries = FS_DIR_MAX_SCAN_ENTRIES,
): { real: string; all: FsDirEntry[]; truncated: boolean } | { error: string } {
  const real = inside(root, rel === "" ? "." : rel);
  if (!real) return { error: "path is outside the session workspace" };
  let dir;
  try {
    dir = opendirSync(real);
  } catch (err) {
    return {
      error:
        (err as NodeJS.ErrnoException).code === "ENOTDIR"
          ? "path is not a directory"
          : "directory is not readable",
    };
  }
  const kindOf = (d: Dirent): FsDirEntry["kind"] =>
    // Order matters: isDirectory() is false for a symlink-to-dir (lstat
    // semantics), so the symlink check needn't come first — but a FIFO or
    // socket lands as `file`, same as the walk lists it (refused at read time).
    d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : "file";
  const all: FsDirEntry[] = [];
  let scanned = 0;
  let truncated = false;
  try {
    for (;;) {
      const d = dir.readSync();
      if (!d) break;
      if (scanned++ >= maxScanEntries) {
        truncated = true;
        break;
      }
      if (!(d.isDirectory() && SKIP_DIRS.has(d.name))) {
        all.push({ name: d.name, kind: kindOf(d) });
      }
    }
  } catch {
    return { error: "directory is not readable" };
  } finally {
    try {
      dir.closeSync();
    } catch {
      // The listing result already says whether the scan itself succeeded.
    }
  }
  return { real, all, truncated };
}

/**
 * Order and cap the bounded raw scan for the wire. Directories sort before
 * files, alphabetical within each group, so the reply cap cuts scanned files
 * first. If the earlier raw work cap trips, entries later in filesystem order
 * are unknown and `truncated` tells the client the listing is incomplete.
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
 * List ONE directory's children — the lazy tree's fetch unit, plain
 * (no git view): readDirRaw + sortAndCapDir. The SKIP_DIRS floor carries
 * over: a `.git`/`node_modules` DIRECTORY is omitted, exactly as the
 * whole-tree walk prunes it. The tests' composition of the two exported
 * halves — production (fs-handlers.ts) composes them directly.
 */
export function listDir(
  root: string,
  rel: string,
  caps: { maxEntries?: number; maxNameBytes?: number; maxScanEntries?: number } = {},
): DirResult {
  const raw = readDirRaw(root, rel, caps.maxScanEntries);
  if ("error" in raw) return raw;
  const capped = sortAndCapDir(raw.all, caps);
  return { entries: capped.entries, truncated: raw.truncated || capped.truncated };
}

/**
 * Read one workspace file for the viewer: jailed, secret-denied, binary-
 * sniffed, cap-honest. `rel` is the client's requested root-relative path —
 * a REQUEST, never trusted: it resolves through `inside()` or not at all.
 */
const readRegularFile = (
  real: string,
  options: { revision?: boolean; revisionCapBytes?: number },
): FileResult => {
  let fd;
  try {
    // O_NOFOLLOW closes the lstat→open race on the diff path: a working file
    // cannot be swapped for an out-of-workspace symlink between validation
    // and the descriptor read. O_NONBLOCK keeps a swapped FIFO/device from
    // stalling before fstat can reject it. `inside()` has already resolved
    // ordinary folder tree symlinks, preserving that existing behavior there.
    fd = openSync(
      real,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return { error: "file is not readable" };
  }
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) return { error: "path is a directory" };
    // A FIFO/socket would stall a read and, with it, the daemon's event loop —
    // the same lesson as the cwd-handoff lstat gate.
    if (!st.isFile()) return { error: "not a regular file" };
    const size = st.size;
    // The review path reads and hashes one stable, bounded snapshot through
    // the same descriptor. Ordinary folder tree reads stay on the original 64 KB
    // sniffed path and pay none of this work.
    const revisionCap = options.revisionCapBytes ?? FS_FILE_REVISION_CAP_BYTES;
    return options.revision && size <= revisionCap
      ? readSnapshot(fd, size)
      : readSniffed(fd, size);
  } finally {
    closeSync(fd);
  }
};

/** The review read: the whole file through one descriptor, with a
 *  stability check (size + timestamps unchanged across the read) deciding
 *  whether the content hash may be advertised as a revision. */
const readSnapshot = (fd: number, size: number): FileResult => {
  const opened = fstatSync(fd, { bigint: true });
  const buf = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const n = readSync(fd, buf, read, size - read, read);
    if (n <= 0) break;
    read += n;
  }
  const finished = fstatSync(fd, { bigint: true });
  const stable =
    read === size &&
    opened.size === BigInt(read) &&
    opened.size === finished.size &&
    opened.mtimeNs === finished.mtimeNs &&
    opened.ctimeNs === finished.ctimeNs;
  const exact = buf.subarray(0, read);
  const revision = stable ? contentRevision(exact) : undefined;
  if (sniffBinary(exact)) {
    return { binary: true, size, ...(revision ? { revision } : {}) };
  }
  const capped = capBuffer(exact);
  return {
    content: capped.text,
    size,
    ...(capped.truncatedBytes ? { truncatedBytes: capped.truncatedBytes } : {}),
    ...(revision ? { revision } : {}),
  };
};

/** The folder tree read: sniff the head for binaryness, then keep at most the
 *  display cap — never the whole file. */
const readSniffed = (fd: number, size: number): FileResult => {
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
};

export function readWorkspaceFile(
  root: string,
  rel: string,
  options: { revision?: boolean; revisionCapBytes?: number } = {},
): FileResult {
  const real = inside(root, rel);
  if (!real) return { error: "path is outside the session workspace" };
  if (isSecretFile(real)) return { error: "environment files are never readable here" };
  return readRegularFile(real, options);
}

const isMissingPath = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** Read the working-tree side of a Git diff without following the leaf
 * symlink. A tracked symlink's content is its link text, exactly as stored in
 * Git; a genuinely absent path is distinct from an unreadable or escaped one. */
export function readWorkspaceDiffEntry(
  root: string,
  rel: string,
  options: { revision?: boolean; revisionCapBytes?: number } = {},
): DiffEntryResult {
  const parentRel = path.posix.dirname(rel);
  const realParent = inside(root, parentRel === "." ? "." : parentRel);
  if (!realParent) {
    // `inside()` intentionally returns one null for missing, inaccessible,
    // and escaped paths. Probe only the error class so a deleted directory is
    // a real empty after-side while EACCES cannot masquerade as deletion.
    try {
      lstatSync(path.resolve(root, ...rel.split("/")));
      return { error: "path is outside the session workspace" };
    } catch (err) {
      return isMissingPath(err) ? { absent: true } : { error: "file is not readable" };
    }
  }

  const absolute = path.join(realParent, path.posix.basename(rel));
  if (isSecretFile(absolute)) return { error: "environment files are never readable here" };
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (err) {
    return isMissingPath(err) ? { absent: true } : { error: "file is not readable" };
  }
  if (stat.isDirectory()) return { error: "path is a directory" };
  if (!stat.isSymbolicLink()) return readRegularFile(absolute, options);

  try {
    const content = readlinkSync(absolute, { encoding: "buffer" });
    const revisionCap = options.revisionCapBytes ?? FS_FILE_REVISION_CAP_BYTES;
    const revision = options.revision && content.byteLength <= revisionCap
      ? contentRevision(content)
      : undefined;
    const capped = capBuffer(content);
    return {
      content: capped.text,
      size: content.byteLength,
      ...(capped.truncatedBytes ? { truncatedBytes: capped.truncatedBytes } : {}),
      ...(revision ? { revision } : {}),
    };
  } catch {
    return { error: "file is not readable" };
  }
}
