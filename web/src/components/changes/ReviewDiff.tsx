import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  MAX_REVIEW_SELECTION,
  closestHunk,
  formatReviewDraft,
  interactiveReviewTooLarge,
  languageForPath,
  reviewHunks,
  reviewLines,
  reviewSelection,
  reviewScrollBehavior,
  type VersionedReviewSelection,
} from "../../change-review";
import { formatBytes } from "../ToolBlock";
import { diffTooLarge, FileView, type FileViewState } from "../files/FileView";
import { ReviewRows } from "./ReviewRows";

type DiffState = Extract<FileViewState, { kind: "diff" }>;

export function ReviewDiff({
  state,
  phone,
  onCreateDraft,
  selection,
  onSelectionChange,
  onNoticeChange,
}: {
  state: DiffState;
  phone: boolean;
  onCreateDraft: (text: string) => void;
  selection?: VersionedReviewSelection;
  onSelectionChange: (selection: VersionedReviewSelection | undefined) => void;
  onNoticeChange: (notice: string | undefined) => void;
}) {
  const matrixTooLarge = diffTooLarge(state.before, state.after);
  const rowCountTooLarge = interactiveReviewTooLarge(state.before, state.after);
  const lines = useMemo(
    () => (matrixTooLarge || rowCountTooLarge ? [] : reviewLines(state.before, state.after)),
    [state.before, state.after, matrixTooLarge, rowCountTooLarge],
  );
  const hunks = useMemo(() => reviewHunks(lines), [lines]);
  const language = useMemo(() => languageForPath(state.path), [state.path]);
  const [currentHunk, setCurrentHunk] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dragAnchor = useRef<number | null>(null);
  const pendingHunkScroll = useRef<number | null>(null);
  const positionedPath = useRef<string | null>(null);

  const currentSelection =
    selection &&
    selection.path === state.path &&
    selection.before === state.before &&
    selection.after === state.after
      ? selection
      : undefined;
  const selectedLines = currentSelection
    ? lines.slice(currentSelection.start, currentSelection.end + 1)
    : [];

  // Row refs are NOT wiped here: removed rows already null their slots via
  // React's ref detach, and the effects below need the fresh refs that a
  // wipe would destroy (they attach during commit, before effects run).
  useEffect(() => {
    setCurrentHunk(0);
    setFocusIndex(hunks[0]?.start ?? 0);
    // Review starts on the first hunk, so "Hunk 1 of N" is what the viewport
    // shows. Only on a real file switch — a live content refresh under the
    // reader must never yank the view back to the first hunk.
    if (positionedPath.current !== state.path) {
      positionedPath.current = state.path;
      if (hunks[0]) rowRefs.current[hunks[0].start]?.scrollIntoView({ block: "center" });
    }
  }, [state.path, state.before, state.after, hunks]);

  // Hunk-navigation scrolling is deferred past this click's commit: arriving
  // at a terminal hunk disables the very button being clicked, Chromium blurs
  // a focused element that becomes disabled, and that focus change cancels a
  // smooth scroll already in flight (probed 2026-08-12 — the animation dies
  // at zero pixels). After the commit the blur has already happened.
  useEffect(() => {
    const target = pendingHunkScroll.current;
    if (target === null) return;
    pendingHunkScroll.current = null;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    rowRefs.current[target]?.scrollIntoView({
      block: "center",
      behavior: reviewScrollBehavior(reducedMotion),
    });
  }, [currentHunk]);

  useEffect(() => {
    const finishDrag = () => {
      dragAnchor.current = null;
    };
    window.addEventListener("mouseup", finishDrag);
    return () => window.removeEventListener("mouseup", finishDrag);
  }, []);

  const select = (anchor: number, focus: number) => {
    const next = reviewSelection(anchor, focus, lines.length);
    if (!next) return;
    const versioned = { ...next, path: state.path, before: state.before, after: state.after };
    onSelectionChange(versioned);
    onNoticeChange(
      next.clamped
        ? `Selection limited to ${MAX_REVIEW_SELECTION} lines; start a second draft for more.`
        : undefined,
    );
    const hunk = closestHunk(hunks, next.focus);
    if (hunk >= 0) setCurrentHunk(hunk);
  };

  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(lines.length - 1, index));
    setFocusIndex(next);
    rowRefs.current[next]?.focus({ preventScroll: true });
  };

  const onLineKey = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    let next: number | undefined;
    if (event.key === "ArrowUp") next = index - 1;
    else if (event.key === "ArrowDown") next = index + 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = lines.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      const bounded = Math.max(0, Math.min(lines.length - 1, next));
      if (event.shiftKey) select(currentSelection?.anchor ?? index, bounded);
      focusRow(bounded);
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      select(event.shiftKey ? currentSelection?.anchor ?? index : index, index);
    }
  };

  const goToHunk = (index: number) => {
    const next = Math.max(0, Math.min(hunks.length - 1, index));
    const hunk = hunks[next];
    if (!hunk) return;
    pendingHunkScroll.current = hunk.start;
    setCurrentHunk(next);
    setFocusIndex(hunk.start);
  };

  const createDraft = (intent: "explain" | "request-change") => {
    if (selectedLines.length === 0) return;
    onCreateDraft(formatReviewDraft(intent, state.path, selectedLines));
    onNoticeChange("Draft added to the prompt — it has not been sent.");
  };

  if (matrixTooLarge) {
    return <FileView state={state} />;
  }

  if (rowCountTooLarge) {
    return (
      <>
        {(state.beforeTruncatedBytes || state.afterTruncatedBytes) && (
          <div className="fv-note">
            Diff is truncated — {formatBytes((state.beforeTruncatedBytes ?? 0) + (state.afterTruncatedBytes ?? 0))}
            {" "}elided. Changes past the cap may be overstated.
          </div>
        )}
        <div className="fv-note">Too many lines for interactive review — showing current contents.</div>
        <pre className="tool-code fv-content">{state.after}</pre>
      </>
    );
  }

  if (lines.length === 0) return <FileView state={state} />;

  const hunk = hunks[currentHunk];
  return (
    <div className="changes-diff-review">
      {(state.beforeTruncatedBytes || state.afterTruncatedBytes) && (
        <div className="fv-note">
          Diff is truncated — {formatBytes((state.beforeTruncatedBytes ?? 0) + (state.afterTruncatedBytes ?? 0))}
          {" "}elided. Changes past the cap may be overstated.
        </div>
      )}
      <div className="changes-review-tools">
        <div className="changes-hunk-nav" aria-label="Changed hunk navigation">
          <button
            type="button"
            onClick={() => goToHunk(currentHunk - 1)}
            disabled={currentHunk <= 0}
            aria-label="Previous changed hunk"
            title="Previous changed hunk"
          >
            ‹
          </button>
          <span>{hunks.length > 0 ? `Hunk ${currentHunk + 1} of ${hunks.length}` : "No textual hunks"}</span>
          <button
            type="button"
            onClick={() => goToHunk(currentHunk + 1)}
            disabled={currentHunk >= hunks.length - 1}
            aria-label="Next changed hunk"
            title="Next changed hunk"
          >
            ›
          </button>
          <button
            type="button"
            className="changes-select-hunk"
            disabled={!hunk}
            onClick={() => hunk && select(hunk.start, hunk.end)}
          >
            Select hunk
          </button>
        </div>
        <div className="changes-draft-actions">
          <span className="changes-selection-count">
            {selectedLines.length > 0 ? `${selectedLines.length} selected` : "Select lines to respond"}
          </span>
          <button type="button" disabled={selectedLines.length === 0} onClick={() => createDraft("explain")}>
            Explain
          </button>
          <button
            type="button"
            disabled={selectedLines.length === 0}
            onClick={() => createDraft("request-change")}
          >
            Request change
          </button>
        </div>
      </div>

      <div
        className="changes-diff-lines"
        role="listbox"
        aria-label={`${state.path} changed lines`}
        aria-multiselectable="true"
      >
        <ReviewRows
          language={language}
          lines={lines}
          selection={currentSelection}
          focusIndex={focusIndex}
          phone={phone}
          rowRefs={rowRefs}
          dragAnchor={dragAnchor}
          select={select}
          setFocusIndex={setFocusIndex}
          onLineKey={onLineKey}
        />
      </div>
    </div>
  );
}
