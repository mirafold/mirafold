import type { ChangeItem } from "./changes";

/** One browser viewport's explicit review decisions. The server-minted value
 * identifies the exact HEAD + working-tree bytes the user marked. Nothing is
 * persisted or shared with another viewport. */
export type ReviewProgress = ReadonlyMap<string, string>;

export const emptyReviewProgress = (): ReviewProgress => new Map();

export function setFileReviewed(
  progress: ReviewProgress,
  path: string,
  revision: string,
  reviewed: boolean,
): ReviewProgress {
  const next = new Map(progress);
  if (reviewed) next.set(path, revision);
  else next.delete(path);
  return next;
}

export const fileIsReviewed = (
  progress: ReviewProgress,
  path: string,
  revision?: string,
): boolean => Boolean(revision && progress.get(path) === revision);

/** A file that left the visible change set cannot carry a stale decision if
 * it later reappears in this viewport. */
export function pruneReviewProgress(
  progress: ReviewProgress,
  items: readonly Pick<ChangeItem, "path">[],
): ReviewProgress {
  const visible = new Set(items.map((item) => item.path));
  return new Map([...progress].filter(([path]) => visible.has(path)));
}

const pathTouches = (hint: string, reviewedPath: string): boolean =>
  hint === reviewedPath ||
  hint.startsWith(`${reviewedPath}/`) ||
  reviewedPath.startsWith(`${hint}/`);

const changesHead = (hint: string): boolean =>
  /(^|\/)\.git\/(HEAD|packed-refs)$/.test(hint) || /(^|\/)\.git\/refs\//.test(hint);

/** Apply the watcher's best-effort paths immediately. Exact worktree hints
 * invalidate only matching files. A changed HEAD alters every comparison;
 * an incomplete/absent hint cannot support a trustworthy selective claim,
 * so it invalidates all reviewed markers. `.git/index` alone is harmless:
 * this surface compares HEAD with the working tree, not the staging area. */
export function invalidateReviewProgress(
  progress: ReviewProgress,
  change: { paths?: readonly string[]; truncated?: boolean },
): { progress: ReviewProgress; invalidated: string[] } {
  if (progress.size === 0) return { progress, invalidated: [] };
  const paths = change.paths;
  const all = Boolean(change.truncated || !paths || paths.length === 0 || paths.some(changesHead));
  const invalidated = [...progress.keys()].filter(
    (reviewedPath) => all || paths!.some((hint) => hint === "." || pathTouches(hint, reviewedPath)),
  );
  if (invalidated.length === 0) return { progress, invalidated };
  const next = new Map(progress);
  invalidated.forEach((path) => next.delete(path));
  return { progress: next, invalidated };
}

export const reviewedFileCount = (
  progress: ReviewProgress,
  items: readonly Pick<ChangeItem, "path">[],
): number => items.filter((item) => progress.has(item.path)).length;

/** The next unreviewed file after the current selection, wrapping once. The
 * current file is not a navigation target; if it is the only unreviewed file,
 * the user is already there and there is nowhere to move. */
export function nextUnreviewedIndex(
  items: readonly Pick<ChangeItem, "path">[],
  progress: ReviewProgress,
  currentPath?: string,
): number {
  if (items.length === 0) return -1;
  const current = items.findIndex((item) => item.path === currentPath);
  if (current < 0) return items.findIndex((item) => !progress.has(item.path));
  for (let step = 1; step < items.length; step += 1) {
    const index = (current + step) % items.length;
    if (!progress.has(items[index].path)) return index;
  }
  return -1;
}
