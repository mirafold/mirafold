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
  type VersionedReviewSelection,
} from "../../change-review";
import { formatBytes } from "../ToolBlock";
import { diffTooLarge, FileView, type FileViewState } from "../files/FileView";
import { ReviewRows } from "./ReviewRows";
import { useHunkNavigation } from "./use-hunk-navigation";

type DiffState = Extract<FileViewState, { kind: "diff" }>;

function TruncationNote({ state }: { state: DiffState }) {
  if (!state.beforeTruncatedBytes && !state.afterTruncatedBytes) return null;
  return (
    <div className="fv-note">
      Diff is truncated — {formatBytes((state.beforeTruncatedBytes ?? 0) + (state.afterTruncatedBytes ?? 0))}
      {" "}elided. Changes past the cap may be overstated.
    </div>
  );
}

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
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dragAnchor = useRef<number | null>(null);
  const { currentHunk, setCurrentHunk, goToHunk } = useHunkNavigation({
    path: state.path,
    before: state.before,
    after: state.after,
    hunks,
    rowRefs,
    setFocusIndex,
  });

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

  // "Select hunk" toggles: clicking it while its exact range is selected
  // unselects. Compare against the CLAMPED range — an over-cap hunk selects
  // fewer lines than it spans, and that clamped selection must still read
  // as "this hunk is selected" or the button could never unselect it.
  const hunk = hunks[currentHunk];
  const hunkTarget = hunk ? reviewSelection(hunk.start, hunk.end, lines.length) : undefined;
  const hunkSelected = Boolean(
    hunkTarget &&
      currentSelection &&
      currentSelection.start === hunkTarget.start &&
      currentSelection.end === hunkTarget.end,
  );
  const toggleHunkSelection = () => {
    if (!hunk) return;
    if (hunkSelected) {
      onSelectionChange(undefined);
      onNoticeChange(undefined);
    } else {
      select(hunk.start, hunk.end);
    }
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
        <TruncationNote state={state} />
        <div className="fv-note">Too many lines for interactive review — showing current contents.</div>
        <pre className="tool-code fv-content">{state.after}</pre>
      </>
    );
  }

  if (lines.length === 0) return <FileView state={state} />;

  return (
    <div className="changes-diff-review">
      <TruncationNote state={state} />
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
            aria-pressed={hunkSelected}
            onClick={toggleHunkSelection}
          >
            {hunkSelected ? "Unselect hunk" : "Select hunk"}
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
