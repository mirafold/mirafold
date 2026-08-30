// Repo-configured program execution, refused by default.
//
// The problem: git can be told, by settings living inside a repository's own
// `.git/config`, to RUN a program during ordinary read-only commands. The
// folder tree runs `git status` automatically the moment a panel opens — no
// permission prompt, because it is the daemon's own call, not an agent tool.
// So a repository that arrived carrying its own `.git` directory (a tarball
// or zip, never a `git clone` — cloning deliberately does not copy config)
// could run code the moment its folder is browsed.
//
// The rule here: Mirafold refuses those programs by default and says so; the
// user can allow a specific repo, and then it behaves exactly as their
// terminal does. Refusing costs nothing when nothing is configured, which is
// the overwhelmingly common case — the scan finds nothing and no `-c`
// argument is added.
//
// WHICH settings are listed below is tied to WHICH commands the daemon runs
// (status, ls-files, rev-parse, show). Each was proven by probe: a marker
// script in every candidate setting, then our exact commands, recording what
// actually executed. Smudge/textconv/external-diff drivers, the signing
// program, pager, editor, ssh command, credential helper and every hook did
// NOT fire for these commands and are deliberately absent. **Adding a new
// git command to the daemon means re-running that probe** — a command we
// don't run today may execute settings this list does not cover.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createLogger, stateDir } from "../log";
import { envInt } from "../env";
import { locateTrustedExecutable } from "../security/executable-trust";

/** The one git the daemon runs: resolved through the trusted-executable
 *  lookup like every other daemon-owned child — never a bare name the OS
 *  would search a checkout's `node_modules/.bin` (npx) or its cwd (win32)
 *  for. Undefined means "no git": every caller degrades to not-a-repo. */
let gitBinCache: string | undefined | null = null;
export function gitBin(): string | undefined {
  if (gitBinCache === null) {
    gitBinCache = locateTrustedExecutable("git");
    if (!gitBinCache) {
      // Silent degradation reads as "the tree shows no git info" — say why
      // once (a git only under the launch directory is deliberately ignored).
      createLogger("git").warn(
        "no trusted git executable found on PATH (one inside the launch directory is ignored) — file statuses and changes are off",
      );
    }
  }
  return gitBinCache;
}
/** Test seam: forget the cached lookup (PATH changed). */
export function resetGitBinCache(): void {
  gitBinCache = null;
}

// Shared with every git invocation in git.ts — one timebox for the family.
export const GIT_TIMEOUT_MS = envInt("FS_GIT_TIMEOUT_MS", 5_000);
// A config dump is small; this only bounds a pathological repo's memory.
const CONFIG_MAX_BUFFER = 2 * 1024 * 1024;
// Each named filter driver costs one `-c` argument to neutralize. A repo
// naming more than this is not a real project — rather than build an
// unbounded command line, git is skipped for it entirely (plain listings,
// no statuses), which is the same honest degrade as "not a repo".
const MAX_FILTER_DRIVERS = 64;

/** `core.fsmonitor` values that name no external program (git's own builtin
 *  watcher, or off). Anything else is a path to something that gets run. */
const INERT_FSMONITOR = new Set(["", "true", "false", "1", "0", "yes", "no"]);

export type RepoTrust = {
  /** Settings that would make git run a program, effective for this repo. */
  risky: { key: string; value: string }[];
  /** `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` for the
   *  child's env, neutralizing them for one invocation — empty when the repo
   *  configures nothing risky, or when the user has allowed it. Env pairs,
   *  not `-c key=value`: key and value are separate variables, so a `=`
   *  inside a driver's name (`[filter "ev=il"]`) cannot split the override
   *  — git cut `-c` at the first `=` and left the real driver armed
   *  (audit 2026-08-26). */
  disableEnv: Record<string, string>;
  /** The user allowed this repo: its programs run, terminal-identically. */
  allowed: boolean;
  /** Too many drivers to neutralize one by one — skip git for this repo. */
  unscannable: boolean;
};

const SAFE: RepoTrust = { risky: [], disableEnv: {}, allowed: false, unscannable: false };
const UNSCANNABLE: RepoTrust = { risky: [], disableEnv: {}, allowed: false, unscannable: true };

/**
 * The repo's OWN config — `--local` scope only. The threat is what the repo
 * brought with it; the user's global/system config (git-lfs's filters on any
 * machine that ever ran `git lfs install`, a global fsmonitor) is their own
 * terminal's behavior and must not be flagged — scanning the merged config
 * would mark every repo risky for every LFS user (CI's runners preconfigure
 * LFS system-wide). Reading config runs nothing
 * (probed) and still resolves `include.path` indirection from the local file,
 * so a setting hidden in an included file is found — a textual read of
 * `.git/config` would miss it. Failure (no repo, no git binary) yields no
 * entries, which lands as "nothing risky": correct, since a git that cannot
 * run cannot run anything for an attacker either.
 */
const readConfig = (root: string): Promise<Map<string, string> | null> =>
  new Promise((resolve) => {
    const git = gitBin();
    if (!git) return resolve(new Map());
    execFile(
      git,
      // --includes is explicit: given a single scope, git defaults it OFF,
      // which would hide exactly the included-file indirection pinned below.
      ["--no-optional-locks", "-C", root, "config", "--local", "--includes", "--list", "-z"],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: CONFIG_MAX_BUFFER, encoding: "utf8" },
      (err, stdout, stderr) => {
        const entries = new Map<string, string>();
        if (err) {
          // No git, or not a repo: nothing can run. ANY other failure —
          // our own maxBuffer on a padded config, a timeout — is the SCAN
          // failing, not git: fail closed (null → unscannable). A config
          // padded past 2 MB used to hide a live driver behind an empty
          // map (audit 2026-08-26, probed).
          // Not-a-repo is git's own verdict — exit 128 plus one of its two
          // wordings on STDERR (the callback's third argument; `err.message`
          // embeds the command line, i.e. the root PATH, which a tarball
          // names — cold review 2026-08-26). A signal (timeout) or our own
          // maxBuffer never counts as "not a repo".
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          const exit = typeof e.code === "number" ? e.code : undefined;
          const notRepo =
            e.code === "ENOENT" ||
            (exit === 128 &&
              !e.killed &&
              !e.signal &&
              /not a git repository|can only be used inside a git repository/i.test(String(stderr ?? "")));
          return resolve(notRepo ? entries : null);
        }
        // -z records are `key\nvalue\0`; a valueless key has no newline.
        for (const record of stdout.split("\0")) {
          if (!record) continue;
          const cut = record.indexOf("\n");
          entries.set(
            cut === -1 ? record : record.slice(0, cut),
            cut === -1 ? "" : record.slice(cut + 1),
          );
        }
        resolve(entries);
      },
    );
  });

/** The risky entries in an effective config, and how to neutralize each.
 *  Pure — exported for the Tier-1 pin. */
export function assessConfig(entries: ReadonlyMap<string, string>): {
  risky: { key: string; value: string }[];
  disableEnv: Record<string, string>;
  unscannable: boolean;
} {
  const risky: { key: string; value: string }[] = [];
  const overrides: [string, string][] = [];
  let drivers = 0;

  const fsmonitor = entries.get("core.fsmonitor");
  if (fsmonitor !== undefined && !INERT_FSMONITOR.has(fsmonitor.trim().toLowerCase())) {
    risky.push({ key: "core.fsmonitor", value: fsmonitor });
    overrides.push(["core.fsmonitor", "false"]);
  }
  for (const [key, value] of entries) {
    if (!/^filter\..+\.(clean|process)$/.test(key)) continue;
    if (++drivers > MAX_FILTER_DRIVERS) return { risky, disableEnv: {}, unscannable: true };
    risky.push({ key, value });
    overrides.push([key, ""]);
  }
  const disableEnv: Record<string, string> = {};
  if (overrides.length) {
    disableEnv["GIT_CONFIG_COUNT"] = String(overrides.length);
    overrides.forEach(([key, value], i) => {
      disableEnv[`GIT_CONFIG_KEY_${i}`] = key;
      disableEnv[`GIT_CONFIG_VALUE_${i}`] = value;
    });
  }
  return { risky, disableEnv, unscannable: false };
}

// --- The user's allow list ---
//
// One line of state: repo roots whose own git programs the user accepted.
// Kept beside the log file (the daemon's existing state-dir convention) and
// read from disk on every check, so allowing a repo takes effect without a
// restart and a hand-edit is honored immediately.

function defaultTrustFile(): string {
  return path.join(stateDir(), "trusted-repos.json");
}

/** The allow-list path, or null when disabled (MIRAFOLD_TRUST_FILE=""),
 *  resolved per call — the list itself is re-read from disk every time, so
 *  the path it lives at is settled the same way rather than frozen at
 *  import. */
export const trustFile = (): string | null =>
  process.env.MIRAFOLD_TRUST_FILE === undefined
    ? defaultTrustFile()
    : process.env.MIRAFOLD_TRUST_FILE || null;

/** Repo roots the user has allowed. A missing or malformed file means "none
 *  allowed" — the safe reading, never a crash. */
export function allowedRepos(): Set<string> {
  const file = trustFile();
  if (!file) return new Set();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { repos?: unknown })?.repos ?? []);
    return new Set(Array.isArray(list) ? list.filter((r): r is string => typeof r === "string") : []);
  } catch {
    return new Set();
  }
}

// Per-root cache: one config read per repo, shared by the listing burst.
// Cleared by the same signal that clears statuses — a change under `.git`
// rings the watcher, so an edited config is re-read within one bell.
const trustCache = new Map<string, Promise<RepoTrust>>();

export function invalidateRepoTrustCache(): void {
  trustCache.clear();
}

/**
 * What this root's git config would run, and how to stop it. Cached per
 * root; the ALLOW check is re-read from disk on every call, so allowing a
 * repo takes effect on the next listing rather than after a restart.
 */
export async function repoTrust(root: string): Promise<RepoTrust> {
  let pending = trustCache.get(root);
  if (!pending) {
    pending = readConfig(root).then((entries) =>
      entries === null ? UNSCANNABLE : { ...assessConfig(entries), allowed: false },
    );
    if (trustCache.size > 64) trustCache.clear();
    trustCache.set(root, pending);
  }
  const scanned = await pending;
  if (!scanned.risky.length && !scanned.unscannable) return SAFE;
  const allowed = allowedRepos().has(root);
  return { ...scanned, allowed, disableEnv: allowed ? {} : scanned.disableEnv };
}
