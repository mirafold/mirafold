// The Explorer's per-viewport request layer (Phase E) — the fs_list /
// fs_listdir / fs_read / fs_diff / fs_changes message handlers, lifted out of
// connection.ts's switch so the Explorer's
// request handling lives beside its data layer (fs-explorer.ts,
// git.ts) instead of swelling the dispatcher. connection.ts builds one of
// these per connection and delegates the five cases to it.
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
import {
  cleanRelPath,
  decorateGitDir,
  findRepoRoot,
  gitShowHead,
  gitTree,
  repoRelPath,
  repoStatus,
  workspaceChanges,
} from "./git";
import { repoTrust, trustFile } from "./git-trust";
import { inside } from "./actions";
import { isSecretFile } from "../security/permissions";
import { errText } from "../adapters";
import { envInt } from "../env";

// Minimum gap between Explorer requests per connection AND per type — fs_list
// walks the tree, so a hostile client must not turn it into a CPU grinder; the
// per-type split keeps a legitimate list-then-read pair from tripping it. A
// throttled request still gets a reply (an error), never silence — the client's
// request/reply correlation must always resolve.
const FS_MIN_INTERVAL_MS = envInt("FS_MIN_INTERVAL_MS", 250);

// fs_listdir's throttle is a token BUCKET, not the min-interval family
// (E2.1): opening the panel legitimately fires root + a first level of
// fetches in the same instant, which a min-interval would refuse — and one
// readdir is orders cheaper than the tree walk the interval was sized for.
// Capacity = refill rate, one knob: a full burst of this many, sustained at
// this many per second. A drained bucket still ANSWERS (error reply).
const FS_LISTDIR_MAX_PER_SEC = envInt("FS_LISTDIR_MAX_PER_SEC", 32);

// W.H1: how long a directory listing may wait on its repo's git status
// before shipping plain. Status calls serialize in one GLOBAL queue, so one
// pathological repo (network mount, cold cache) would otherwise hold every
// viewport's listings hostage for up to the 5s git timeout. Well above the
// measured healthy case (~40ms on a 1.1GB repo), well under the timeout.
const FS_LISTDIR_STATUS_WAIT_MS = envInt("FS_LISTDIR_STATUS_WAIT_MS", 300);

// The one shape rule for client-minted ids (fs correlation ids, bang ids):
// short and word-safe or the message is dropped whole.
export const CLIENT_ID_RE = /^[\w-]{1,64}$/;

const fileExists = (abs: string): boolean => {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
};

// E2.4: HEAD's version comes from the repo that CONTAINS the file —
// nearest .git above its directory — so a file in a NESTED repo diffs
// through that repo, closing E2.3's recorded gap. The wire path is
// already textually contained (cleanRelPath), and the directory
// resolves through the realpath jail before any discovery; if it can't
// (say the whole directory was deleted), fall back to the session root,
// which is exactly the pre-E2.4 behavior. repoRel stays clean by
// construction: realDir is jailed under the root and repoRoot is an
// ancestor of realDir, so the relative path has no `..` to offer git.
const resolveDiffRepo = (
  root: string,
  rel: string,
): { repoRoot: string | null; repoRel: string } => {
  const cut = rel.lastIndexOf("/");
  const realDir = inside(root, cut === -1 ? "." : rel.slice(0, cut));
  const repoRoot = realDir ? findRepoRoot(realDir) : null;
  const repoRel =
    repoRoot && realDir
      ? [repoRelPath(repoRoot, realDir), rel.slice(cut + 1)].filter(Boolean).join("/")
      : rel;
  return { repoRoot, repoRel };
};

type FsList = Extract<ClientMsg, { type: "fs_list" }>;
type FsListdir = Extract<ClientMsg, { type: "fs_listdir" }>;
type FsRead = Extract<ClientMsg, { type: "fs_read" }>;
type FsDiff = Extract<ClientMsg, { type: "fs_diff" }>;
type FsChanges = Extract<ClientMsg, { type: "fs_changes" }>;

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
  changes: (msg: FsChanges) => void;
};

export function createFsHandlers({ viewport, getEntry, isClosed }: FsDeps): FsHandlers {
  // Per-connection state: one throttle clock per request type, and at most one
  // git child in flight (shared by list + diff + changes, like the bang
  // already-running refusal).
  let lastListAt = 0;
  let lastReadAt = 0;
  let lastDiffAt = 0;
  let lastChangesAt = 0;
  let gitInFlight = false;
  // fs_listdir's token bucket (see FS_LISTDIR_MAX_PER_SEC above): fractional
  // tokens accrue continuously, capped at one full burst.
  let listdirTokens = FS_LISTDIR_MAX_PER_SEC;
  let listdirRefilledAt = Date.now();
  // Repos whose status outran the listing bound (W.H1) — this connection is
  // owed ONE follow-up bell per repo when that status lands, however many
  // listings timed out against it (a prefetch burst must not ring N times).
  const lateStatusBells = new Set<string>();
  // Repos already reported as configuring programs Mirafold refused to run
  // (the 2026-07-26 audit's default): the prefetch burst hits one repo many
  // times, and the user needs to be told once, not per directory.
  const trustNoticed = new Set<string>();

  /**
   * Say — once per repo, in the shell's own words — that this repo asked git
   * to run a program and Mirafold didn't. Silent for the ordinary repo that
   * configures nothing, and silent once the user has allowed this one.
   */
  const noticeRefusedPrograms = async (repoRoot: string): Promise<void> => {
    if (trustNoticed.has(repoRoot)) return;
    const trust = await repoTrust(repoRoot);
    if (isClosed() || trustNoticed.has(repoRoot)) return;
    if (trust.allowed || (!trust.risky.length && !trust.unscannable)) return;
    trustNoticed.add(repoRoot);
    const what = trust.unscannable
      ? "an unusual number of content filters"
      : trust.risky.map((r) => r.key).join(", ");
    viewport({
      type: "notice",
      text:
        `This project's git settings ask git to run a program (${what}), and Mirafold skipped it — ` +
        `file statuses still work. If you set this up yourself, add ${repoRoot} to ` +
        `${trustFile() ?? "the trusted-repos file"} to allow it.`,
    });
  };

  const badId = (id: unknown): boolean => typeof id !== "string" || !CLIENT_ID_RE.test(id);
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
      //
      // W.H1: the reply never waits on git past the bound. On timeout the
      // plain listing ships NOW; when the status finally settles usable,
      // one synthetic bell tells this viewport to refetch — by then the
      // status is cached (TTL from settle, W.H2), so the refetch decorates
      // instantly instead of timing out again. A status that settles
      // degraded (not a repo, git error) rings nothing: plain was final.
      const repoRoot = findRepoRoot(raw.real);
      if (!repoRoot) return sendDir(raw.all);
      void noticeRefusedPrograms(repoRoot);
      const dirRel = repoRelPath(repoRoot, raw.real);
      let replied = false;
      const timer = setTimeout(() => {
        if (replied || isClosed()) return;
        replied = true;
        lateStatusBells.add(repoRoot);
        sendDir(raw.all);
      }, FS_LISTDIR_STATUS_WAIT_MS);
      void repoStatus(repoRoot)
        .then((st) => {
          if (isClosed()) return clearTimeout(timer);
          if (!replied) {
            clearTimeout(timer);
            replied = true;
            if ("notGit" in st || "error" in st) return sendDir(raw.all);
            return sendDir(decorateGitDir(raw.all, dirRel, st));
          }
          const owed = lateStatusBells.delete(repoRoot);
          if (owed && !("notGit" in st) && !("error" in st)) {
            viewport({ type: "fs_changed", truncated: true });
          }
        })
        .catch(() => {
          lateStatusBells.delete(repoRoot);
          clearTimeout(timer);
          if (isClosed() || replied) return;
          replied = true;
          sendDir(raw.all);
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
    const { repoRoot, repoRel } = resolveDiffRepo(root, rel);
    gitInFlight = true;
    void gitShowHead(repoRoot ?? root, repoRel)
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

  const changes = (msg: FsChanges): void => {
    if (badId(msg.id)) return;
    const sendErr = (error: string) =>
      viewport({ type: "fs_change_set", id: msg.id, repos: [], error });
    const entry = getEntry();
    if (!entry) return sendErr("no session attached");
    if (tooSoon(lastChangesAt)) {
      return sendErr("requests are arriving too fast — retry shortly");
    }
    lastChangesAt = Date.now();
    if (gitInFlight) return sendErr("a git query is already running — retry shortly");

    // Capture the immutable workspace root before awaiting. The query uses the
    // same trusted, hook-disabled git runner as the Explorer's existing tree
    // and diff paths, but returns all changed files grouped by repository.
    const root = entry.cwd;
    gitInFlight = true;
    void workspaceChanges(root)
      .then((result) => {
        if (isClosed()) return;
        if ("error" in result) return sendErr(result.error);
        // The query itself already neutralized repo-configured programs. Match
        // the Files tree's user-facing half of that trust control for every
        // repository the Changes query reached.
        for (const repo of result.repos) {
          const discoveredRoot = path.join(root, repo.root || ".");
          const repoRoot = findRepoRoot(discoveredRoot);
          if (repoRoot) void noticeRefusedPrograms(repoRoot);
        }
        viewport({
          type: "fs_change_set",
          id: msg.id,
          repos: result.repos,
          ...(result.truncated ? { truncated: true } : {}),
        });
      })
      .catch((err) => {
        if (!isClosed()) sendErr(errText(err));
      })
      .finally(() => {
        gitInFlight = false;
      });
  };

  return { list, listdir, read, diff, changes };
}
