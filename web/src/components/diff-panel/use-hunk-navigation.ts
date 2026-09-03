import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { reviewScrollBehavior, type ReviewHunk } from "../../workspace/change-review";

/** Hunk navigation for the review diff: which hunk is current, moving
 * between hunks, and the two positioning behaviors that took probing to get
 * right (first-hunk landing, deferred navigation scrolling). Row focus is
 * the caller's roving-focus concern; this hook only reports where focus
 * should land via `setFocusIndex`. */
export function useHunkNavigation({
  path,
  before,
  after,
  hunks,
  lineCount,
  focusIndex,
  rowRefs,
  setFocusIndex,
}: {
  path: string;
  before: string;
  after: string;
  hunks: readonly ReviewHunk[];
  lineCount: number;
  focusIndex: number;
  rowRefs: MutableRefObject<Array<HTMLDivElement | null>>;
  setFocusIndex: (index: number) => void;
}) {
  const [currentHunk, setCurrentHunk] = useState(0);
  const pendingScroll = useRef<number | null>(null);
  const positionedPath = useRef<string | null>(null);

  // Row refs are NOT wiped on content change: removed rows already null
  // their slots via React's ref detach, and the effects below need the
  // fresh refs that a wipe would destroy (they attach during commit,
  // before effects run).
  useEffect(() => {
    // Review starts on the first hunk, so "Hunk 1 of N" is what the viewport
    // shows. Only on a real file switch — a live content refresh under the
    // reader must never yank the view back to the first hunk. (An
    // unconditional counter reset would relabel the reader's position
    // "Hunk 1 of N" while the viewport stayed put.)
    if (positionedPath.current !== path) {
      positionedPath.current = path;
      setCurrentHunk(0);
      setFocusIndex(hunks[0]?.start ?? 0);
      if (hunks[0]) rowRefs.current[hunks[0].start]?.scrollIntoView({ block: "center" });
      return;
    }
    // Same file, fresh content: keep the reader's place; only clamp what the
    // refresh shrank out from under them — the hunk counter, and the roving
    // focus (a focusIndex past the new line count leaves the listbox with no
    // tabIndex=0 row, stranding keyboard/AT users until a click).
    setCurrentHunk((current) => Math.min(current, Math.max(0, hunks.length - 1)));
    if (focusIndex >= lineCount) setFocusIndex(Math.max(0, lineCount - 1));
  }, [path, before, after, hunks, lineCount, focusIndex, rowRefs, setFocusIndex]);

  // Hunk-navigation scrolling is deferred past this click's commit: arriving
  // at a terminal hunk disables the very button being clicked, Chromium blurs
  // a focused element that becomes disabled, and that focus change cancels a
  // smooth scroll already in flight (the animation dies at zero
  // pixels). After the commit the blur has already happened.
  useEffect(() => {
    const target = pendingScroll.current;
    if (target === null) return;
    pendingScroll.current = null;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    rowRefs.current[target]?.scrollIntoView({
      block: "center",
      behavior: reviewScrollBehavior(reducedMotion),
    });
  }, [currentHunk, rowRefs]);

  const goToHunk = (index: number) => {
    const next = Math.max(0, Math.min(hunks.length - 1, index));
    const hunk = hunks[next];
    if (!hunk) return;
    pendingScroll.current = hunk.start;
    setCurrentHunk(next);
    setFocusIndex(hunk.start);
  };

  return { currentHunk, setCurrentHunk, goToHunk };
}
