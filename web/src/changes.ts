import type { FsChangeRepo, FsEntry } from "@protocol";

export type ChangeItem = FsEntry & {
  repoRoot: string;
  displayPath: string;
};

const KNOWN_STATUS = new Set(["M", "A", "D", "U"]);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Flatten repository groups without losing their explicit ownership. The
 * server already sorts both levels, but sorting here keeps selection stable
 * across version-skewed daemons too. */
export function changeItems(repos: readonly FsChangeRepo[]): ChangeItem[] {
  return repos
    .flatMap((repo) =>
      repo.entries.map((entry) => ({
        ...entry,
        repoRoot: repo.root,
        displayPath:
          repo.root && entry.path.startsWith(`${repo.root}/`)
            ? entry.path.slice(repo.root.length + 1)
            : entry.path,
      })),
    )
    .sort((a, b) =>
      a.repoRoot === b.repoRoot
        ? compare(a.path, b.path)
        : compare(a.repoRoot, b.repoRoot),
    );
}

/** Keep the current file when it still exists; otherwise choose the first
 * deterministic change. */
export function chooseChange(
  items: readonly ChangeItem[],
  currentPath?: string,
): ChangeItem | undefined {
  return items.find((item) => item.path === currentPath) ?? items[0];
}

export function changeSetIncomplete(
  repos: readonly FsChangeRepo[],
  truncated: boolean,
): boolean {
  return truncated || repos.some((repo) => Boolean(repo.truncated || repo.error));
}

export function changeCountLabel(
  repos: readonly FsChangeRepo[],
  truncated: boolean,
): string {
  const count = repos.reduce((sum, repo) => sum + repo.entries.length, 0);
  if (changeSetIncomplete(repos, truncated)) return `${count} visible`;
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

export function changeStatus(status?: string): {
  code: "M" | "A" | "D" | "U" | "?";
  label: string;
} {
  if (!status || !KNOWN_STATUS.has(status)) return { code: "?", label: "Changed" };
  const code = status as "M" | "A" | "D" | "U";
  return {
    code,
    label: {
      M: "Modified",
      A: "Added",
      D: "Deleted",
      U: "Untracked",
    }[code],
  };
}

export function repoLabel(root: string, workspaceLabel?: string): string {
  if (root) return root;
  if (!workspaceLabel) return "Repository";
  const windows = /^[A-Za-z]:[\\/]/.test(workspaceLabel) || workspaceLabel.startsWith("~\\");
  const trimmed = workspaceLabel.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  return trimmed.split(windows ? /[\\/]/ : "/").pop() || "Repository";
}
