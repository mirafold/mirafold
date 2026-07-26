// The Explorer's per-viewport request layer (Phase E) — the fs_list /
// fs_listdir / fs_read / fs_diff message handlers, lifted out of
// connection.ts's switch so the Explorer's
// request handling lives beside its data layer (fs-explorer.ts,
// git.ts) instead of swelling the dispatcher. connection.ts builds one of
// these per connection and delegates the three cases to it.
//
// Every reply is per-viewport: answered on THIS connection only (like
// pong/sessions), never broadcast, never replay-buffered — disk state is a
// query, not session history. A bad correlation id drops the message whole
// (nothing to answer); every well-formed request gets exactly one reply, with
// any error riding the reply rather than vanishing. Handlers never throw: this
// runs on the local WS path, which has no try/catch above it, so an escaped
// throw would exit the daemon.

import { lstatSync } from "node:fs";
import path from "node:path";
import type { ClientMsg, FsDirEntry, FsEntry, WireMsg } from "../protocol";
import type { SessionEntry } from "./registry";
import { capBuffer, listTree, readDirRaw, readWorkspaceFile, sniffBinary, sortAndCapDir } from "./fs-explorer";
import { cleanRelPath, decorateGitDir, findRepoRoot, gitShowHead, gitTree, repoStatus } from "./git";
import { isSecretFile } from "../security/permissions";
import { errText } from "../adapters";

// Minimum gap between Explorer requests per connection AND per type — fs_list
// walks the tree, so a hostile client must not turn it into a CPU grinder; the
// per-type split keeps a legitimate list-then-read pair from tripping it. A
// throttled request still gets a reply (an error), never silence — the client's
// request/reply correlation must always resolve.
const FS_MIN_INTERVAL_MS = Number(process.env.FS_MIN_INTERVAL_MS ?? 250);

// fs_listdir's throttle is a token BUCKET, not the min-interval family
// (E2.1): opening the panel legitimately fires root + a first level of
// fetches in the same instant, which a min-interval would refuse — and one
// readdir is orders cheaper than the tree walk the interval was sized for.
// Capacity = refill rate, one knob: a full burst of this many, sustained at
// this many per second. A drained bucket still ANSWERS (error reply).
const FS_LISTDIR_MAX_PER_SEC = Number(process.env.FS_LISTDIR_MAX_PER_SEC ?? 32);

// Same shape rule as bang ids: client-minted correlation ids are short and
// word-safe or the message is dropped whole.
const FS_ID_RE = /^[\w-]{1,64}$/;

type FsList = Extract<ClientMsg, { type: "fs_list" }>;
type FsListdir = Extract<ClientMsg, { type: "fs_listdir" }>;
type FsRead = Extract<ClientMsg, { type: "fs_read" }>;
type FsDiff = Extract<ClientMsg, { type: "fs_diff" }>;

type FsDeps = {
  /** Send one frame to this viewport (never the broadcast path). */
  viewport: (m: WireMsg) => void;
  /** The session this connection watches, read at call time (it can change). */
  getEntry: () => SessionEntry | null;
  /** Whether the socket is already gone — checked before any async reply. */
  isClosed: () => boolean;
};

export type FsHandlers = {
  list: (msg: FsList) => void;
  listdir: (msg: FsListdir) => void;
  read: (msg: FsRead) => void;
  diff: (msg: FsDiff) => void;
};

export function createFsHandlers({ viewport, getEntry, isClosed }: FsDeps): FsHandlers {
  // Per-connection state: one throttle clock per request type, and at most one
  // git child in flight (shared by list + diff, like the bang already-running
  // refusal).
  let lastListAt = 0;
  let lastReadAt = 0;
  let lastDiffAt = 0;
  let gitInFlight = false;
  // fs_listdir's token bucket (see FS_LISTDIR_MAX_PER_SEC above): fractional
  // tokens accrue continuously, capped at one full burst.
  let listdirTokens = FS_LISTDIR_MAX_PER_SEC;
  let listdirRefilledAt = Date.now();

  const badId = (id: unknown): boolean => typeof id !== "string" || !FS_ID_RE.test(id);
  const tooSoon = (last: number): boolean => Date.now() - last < FS_MIN_INTERVAL_MS;
  const takeListdirToken = (): boolean => {
    const now = Date.now();
    listdirTokens = Math.min(
      FS_LISTDIR_MAX_PER_SEC,
      listdirTokens + ((now - listdirRefilledAt) / 1_000) * FS_LISTDIR_MAX_PER_SEC,
    );
    listdirRefilledAt = now;
    if (listdirTokens < 1) return false;
    listdirTokens -= 1;
    return true;
  };

  const list = (msg: FsList): void => {
    if (badId(msg.id)) return;
    const sendErr = (root: string, error: string) =>
      viewport({ type: "fs_tree", id: msg.id, root, entries: [], git: false, error });
    const entry = getEntry();
    if (!entry) return sendErr("", "no session attached");
    if (tooSoon(lastListAt)) return sendErr(entry.cwd, "requests are arriving too fast — retry shortly");
    lastListAt = Date.now();
    if (gitInFlight) return sendErr(entry.cwd, "a git query is already running — retry shortly");

    // root captured before the await — the viewport may switch sessions under
    // it. Git's view first; not-a-repo / no-git degrades to the plain walk.
    const root = entry.cwd;
    const sendTree = (entries: FsEntry[], git: boolean, truncated: boolean) =>
      viewport({ type: "fs_tree", id: msg.id, root, entries, git, ...(truncated ? { truncated: true } : {}) });
    gitInFlight = true;
    void gitTree(root)
      .then((g) => {
        if (isClosed()) return;
        if ("error" in g) {
          sendErr(root, g.error);
        } else if ("entries" in g) {
          sendTree(g.entries, true, g.truncated);
        } else {
          const r = listTree(root);
          if ("error" in r) sendErr(root, r.error);
          else sendTree(r.entries, false, r.truncated);
        }
      })
      .catch((err) => {
        if (!isClosed()) sendErr(root, errText(err));
      })
      .finally(() => {
        gitInFlight = false;
      });
  };

  const listdir = (msg: FsListdir): void => {
    if (badId(msg.id)) return;
    const sendErr = (p: string, error: string) =>
      viewport({ type: "fs_dir", id: msg.id, path: p, entries: [], error });
    // "" and "." both mean the session root — a length-0 path is valid here,
    // unlike fs_read's. The cap mirrors fs_read's; the jail does the rest.
    if (typeof msg.path !== "string" || msg.path.length > 4_096) {
      return sendErr("", "bad path");
    }
    const entry = getEntry();
    if (!entry) return sendErr(msg.path, "no session attached");
    if (!takeListdirToken()) return sendErr(msg.path, "requests are arriving too fast — retry shortly");
    try {
      const raw = readDirRaw(entry.cwd, msg.path);
      if ("error" in raw) return sendErr(msg.path, raw.error);
      const sendDir = (all: FsDirEntry[]) => {
        const r = sortAndCapDir(all);
        viewport({
          type: "fs_dir",
          id: msg.id,
          path: msg.path,
          entries: r.entries,
          ...(r.truncated ? { truncated: true } : {}),
        });
      };
      // E2.3: a directory inside a repo lists through THAT repo's view —
      // its own ignore rules honored, its own statuses attached (cached per
      // repo, one git child at a time — repoStatus serializes). Outside any
      // repo: the plain listing, byte-identical to E2.1. Git trouble
      // degrades to the plain listing, never to an error — the entries are
      // disk truth either way; statuses are the garnish. Note gitInFlight
      // stays out of this path: the burst is legitimate here, so the
      // discipline is repoStatus's queue, not a refusal.
      const repoRoot = findRepoRoot(raw.real);
      if (!repoRoot) return sendDir(raw.all);
      const dirRel = path.relative(repoRoot, raw.real).split(path.sep).join("/");
      void repoStatus(repoRoot)
        .then((st) => {
          if (isClosed()) return;
          if ("notGit" in st || "error" in st) return sendDir(raw.all);
          sendDir(decorateGitDir(raw.all, dirRel, st));
        })
        .catch(() => {
          if (!isClosed()) sendDir(raw.all);
        });
    } catch (err) {
      sendErr(msg.path, errText(err));
    }
  };

  const read = (msg: FsRead): void => {
    if (badId(msg.id)) return;
    const sendErr = (p: string, error: string) =>
      viewport({ type: "fs_file", id: msg.id, path: p, error });
    if (typeof msg.path !== "string" || msg.path.length === 0 || msg.path.length > 4_096) {
      return sendErr("", "bad path");
    }
    const entry = getEntry();
    if (!entry) return sendErr(msg.path, "no session attached");
    if (tooSoon(lastReadAt)) return sendErr(msg.path, "requests are arriving too fast — retry shortly");
    lastReadAt = Date.now();
    try {
      const r = readWorkspaceFile(entry.cwd, msg.path);
      if ("error" in r) {
        sendErr(msg.path, r.error);
      } else if ("binary" in r) {
        viewport({ type: "fs_file", id: msg.id, path: msg.path, binary: true, size: r.size });
      } else {
        viewport({
          type: "fs_file",
          id: msg.id,
          path: msg.path,
          content: r.content,
          size: r.size,
          ...(r.truncatedBytes ? { truncatedBytes: r.truncatedBytes } : {}),
        });
      }
    } catch (err) {
      sendErr(msg.path, errText(err));
    }
  };

  const diff = (msg: FsDiff): void => {
    if (badId(msg.id)) return;
    const sendErr = (p: string, error: string) =>
      viewport({ type: "fs_file_diff", id: msg.id, path: p, error });
    if (typeof msg.path !== "string") return sendErr("", "bad path");
    // Textual containment BEFORE git sees the path: `git show` resolves against
    // the repo, not the filesystem, so the realpath jail can't cover it — a
    // `../` here could read repo files above a subdirectory session's root.
    const rel = cleanRelPath(msg.path);
    if (!rel) return sendErr(msg.path.slice(0, 200), "bad path");
    const entry = getEntry();
    if (!entry) return sendErr(rel, "no session attached");
    if (isSecretFile(rel)) return sendErr(rel, "environment files are never readable here");
    if (tooSoon(lastDiffAt)) return sendErr(rel, "requests are arriving too fast — retry shortly");
    lastDiffAt = Date.now();
    if (gitInFlight) return sendErr(rel, "a git query is already running — retry shortly");

    const root = entry.cwd;
    gitInFlight = true;
    void gitShowHead(root, rel)
      .then((show) => {
        if (isClosed()) return;
        if ("notGit" in show) return sendErr(rel, "not a git repository — no diff available");
        if ("error" in show) return sendErr(rel, show.error);

        const beforeBuf = "content" in show ? show.content : Buffer.alloc(0);
        if (sniffBinary(beforeBuf)) {
          return viewport({ type: "fs_file_diff", id: msg.id, path: rel, binary: true });
        }
        // The after side. A missing working file is a REAL case (deleted →
        // after ""), not an error — but only plain absence; an existing-but-
        // unreadable path stays an error.
        let after = "";
        let afterTruncatedBytes: number | undefined;
        const exists = fileExists(path.join(root, rel));
        if (exists) {
          const r = readWorkspaceFile(root, rel);
          if ("error" in r) return sendErr(rel, r.error);
          if ("binary" in r) {
            return viewport({ type: "fs_file_diff", id: msg.id, path: rel, binary: true });
          }
          after = r.content;
          afterTruncatedBytes = r.truncatedBytes;
        }
        const before = capBuffer(beforeBuf);
        viewport({
          type: "fs_file_diff",
          id: msg.id,
          path: rel,
          before: before.text,
          after,
          ...(before.truncatedBytes ? { beforeTruncatedBytes: before.truncatedBytes } : {}),
          ...(afterTruncatedBytes ? { afterTruncatedBytes } : {}),
        });
      })
      .catch((err) => {
        if (!isClosed()) sendErr(rel, errText(err));
      })
      .finally(() => {
        gitInFlight = false;
      });
  };

  return { list, listdir, read, diff };
}

const fileExists = (abs: string): boolean => {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
};
