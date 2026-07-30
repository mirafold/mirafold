// Repo-configured program execution, refused by default (2026-07-26 audit).
//
// The problem: git can be told, by settings living inside a repository's own
// `.git/config`, to RUN a program during ordinary read-only commands. The
// Explorer runs `git status` automatically the moment a panel opens — no
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
import { stateDir } from "../log";
import { envInt } from "../env";

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
  /** `-c` arguments neutralizing them for one invocation — empty when the
   *  repo configures nothing risky, or when the user has allowed it. */
  disableArgs: string[];
  /** The user allowed this repo: its programs run, terminal-identically. */
  allowed: boolean;
  /** Too many drivers to neutralize one by one — skip git for this repo. */
  unscannable: boolean;
};

const SAFE: RepoTrust = { risky: [], disableArgs: [], allowed: false, unscannable: false };

/**
 * The effective git config for whatever repo `root` resolves to. Reading
 * config runs nothing (probed) and resolves `include.path` indirection, so a
 * setting hidden in an included file is still found — a textual read of
 * `.git/config` would miss it. Failure (no repo, no git binary) yields no
 * entries, which lands as "nothing risky": correct, since a git that cannot
 * run cannot run anything for an attacker either.
 */
const readConfig = (root: string): Promise<Map<string, string>> =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "-C", root, "config", "--list", "-z"],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: CONFIG_MAX_BUFFER, encoding: "utf8" },
      (err, stdout) => {
        const entries = new Map<string, string>();
        if (err) return resolve(entries);
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
  disableArgs: string[];
  unscannable: boolean;
} {
  const risky: { key: string; value: string }[] = [];
  const disableArgs: string[] = [];
  let drivers = 0;

  const fsmonitor = entries.get("core.fsmonitor");
  if (fsmonitor !== undefined && !INERT_FSMONITOR.has(fsmonitor.trim().toLowerCase())) {
    risky.push({ key: "core.fsmonitor", value: fsmonitor });
    disableArgs.push("-c", "core.fsmonitor=false");
  }
  for (const [key, value] of entries) {
    if (!/^filter\..+\.(clean|process)$/.test(key)) continue;
    if (++drivers > MAX_FILTER_DRIVERS) return { risky, disableArgs, unscannable: true };
    risky.push({ key, value });
    disableArgs.push("-c", `${key}=`);
  }
  return { risky, disableArgs, unscannable: false };
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
    pending = readConfig(root).then((entries) => ({ ...assessConfig(entries), allowed: false }));
    if (trustCache.size > 64) trustCache.clear();
    trustCache.set(root, pending);
  }
  const scanned = await pending;
  if (!scanned.risky.length && !scanned.unscannable) return SAFE;
  const allowed = allowedRepos().has(root);
  return { ...scanned, allowed, disableArgs: allowed ? [] : scanned.disableArgs };
}
