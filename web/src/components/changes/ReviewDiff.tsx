import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import {
  MAX_REVIEW_SELECTION,
  closestHunk,
  formatReviewDraft,
  languageForPath,
  reviewHunks,
  reviewLines,
  reviewSelection,
  type ReviewLine,
  type VersionedReviewSelection,
} from "../../change-review";
import { codeFence, splitNodeLines } from "../../registry/Code";
import { formatBytes } from "../ToolBlock";
import { diffTooLarge, FileView, type FileViewState } from "../files/FileView";

type DiffState = Extract<FileViewState, { kind: "diff" }>;

const syntaxComponents = {
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
  code: ({ children, className }: { children?: ReactNode; className?: string }) => {
    const line = splitNodeLines(children)[0] ?? [];
    return <code className={className}>{line.length > 0 ? line : " "}</code>;
  },
};

const SyntaxLine = memo(function SyntaxLine({ text, language }: { text: string; language?: string }) {
  return (
    <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={syntaxComponents}>
      {codeFence(text, language)}
    </ReactMarkdown>
  );
});

function lineLabel(line: ReviewLine): string {
  const kind = line.sign === "+" ? "Added" : line.sign === "-" ? "Deleted" : "Context";
  const coordinates = [
    line.oldLine === undefined ? undefined : `HEAD line ${line.oldLine}`,
    line.newLine === undefined ? undefined : `working tree line ${line.newLine}`,
  ].filter(Boolean);
  return `${kind}, ${coordinates.join(", ")}: ${line.text || "blank line"}`;
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
  const lines = useMemo(() => reviewLines(state.before, state.after), [state.before, state.after]);
  const hunks = useMemo(() => reviewHunks(lines), [lines]);
  const language = useMemo(() => languageForPath(state.path), [state.path]);
  const [currentHunk, setCurrentHunk] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dragAnchor = useRef<number | null>(null);

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
    setCurrentHunk(0);
    setFocusIndex(hunks[0]?.start ?? 0);
    rowRefs.current = [];
  }, [state.path, state.before, state.after, hunks]);

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
    setCurrentHunk(next);
    setFocusIndex(hunk.start);
    rowRefs.current[hunk.start]?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const createDraft = (intent: "explain" | "request-change") => {
    if (selectedLines.length === 0) return;
    onCreateDraft(formatReviewDraft(intent, state.path, selectedLines));
    onNoticeChange("Draft added to the prompt — it has not been sent.");
  };

  if (diffTooLarge(state.before, state.after) || lines.length === 0) {
    return <FileView state={state} />;
  }

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
        {lines.map((line, index) => {
          const selected = Boolean(
            currentSelection && index >= currentSelection.start && index <= currentSelection.end,
          );
          return (
            <div
              key={line.id}
              ref={(node) => {
                rowRefs.current[index] = node;
              }}
              className={
                "changes-review-line" +
                (line.sign === "+"
                  ? " is-add diff-add"
                  : line.sign === "-"
                    ? " is-del diff-del"
                    : " is-context diff-ctx") +
                (selected ? " is-selected" : "")
              }
              role="option"
              aria-selected={selected}
              aria-label={lineLabel(line)}
              tabIndex={focusIndex === index ? 0 : -1}
              data-review-index={index}
              data-old-line={line.oldLine}
              data-new-line={line.newLine}
              onFocus={() => setFocusIndex(index)}
              onKeyDown={(event) => onLineKey(event, index)}
              onMouseDown={(event) => {
                if (phone || event.button !== 0) return;
                event.preventDefault();
                const anchor = event.shiftKey ? currentSelection?.anchor ?? index : index;
                dragAnchor.current = anchor;
                select(anchor, index);
              }}
              onMouseEnter={() => {
                if (phone || dragAnchor.current === null) return;
                select(dragAnchor.current, index);
              }}
              onClick={() => {
                if (!phone) return;
                select(index, index);
              }}
            >
              <span className="changes-line-no changes-line-old" aria-hidden="true">{line.oldLine ?? ""}</span>
              <span className="changes-line-no changes-line-new" aria-hidden="true">{line.newLine ?? ""}</span>
              <span className="changes-line-sign" aria-hidden="true">{line.sign}</span>
              <span className="changes-line-code" aria-hidden="true">
                <SyntaxLine text={line.text} language={language} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
