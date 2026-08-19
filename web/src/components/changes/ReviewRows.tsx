import {
  createContext,
  useContext,
  useMemo,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type { ReviewLine, VersionedReviewSelection } from "../../change-review";
import { codeFence, splitNodeLines } from "../../registry/Code";

type ReviewRowsValue = {
  lines: readonly ReviewLine[];
  selection?: VersionedReviewSelection;
  focusIndex: number;
  phone: boolean;
  rowRefs: MutableRefObject<Array<HTMLDivElement | null>>;
  dragAnchor: MutableRefObject<number | null>;
  selectLines: (anchor: number, focus: number) => void;
  setFocusIndex: (index: number) => void;
  onLineKey: (event: KeyboardEvent<HTMLDivElement>, index: number) => void;
};

const ReviewRowsContext = createContext<ReviewRowsValue | null>(null);

function SyntaxReviewRows({ children, className }: { children?: ReactNode; className?: string }) {
  const review = useContext(ReviewRowsContext);
  if (!review) return null;
  const syntaxLines = splitNodeLines(children);
  return review.lines.map((line, index) => {
    const selected = Boolean(
      review.selection && index >= review.selection.start && index <= review.selection.end,
    );
    const syntax = syntaxLines[index] ?? [];
    return (
      <div
        key={line.id}
        ref={(node) => {
          review.rowRefs.current[index] = node;
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
        tabIndex={review.focusIndex === index ? 0 : -1}
        data-review-index={index}
        data-old-line={line.oldLine}
        data-new-line={line.newLine}
        onFocus={() => review.setFocusIndex(index)}
        onKeyDown={(event) => review.onLineKey(event, index)}
        onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
          if (review.phone || event.button !== 0) return;
          event.preventDefault();
          const anchor = event.shiftKey ? review.selection?.anchor ?? index : index;
          review.dragAnchor.current = anchor;
          review.selectLines(anchor, index);
        }}
        onMouseEnter={() => {
          if (review.phone || review.dragAnchor.current === null) return;
          review.selectLines(review.dragAnchor.current, index);
        }}
        onClick={() => {
          if (!review.phone) return;
          review.selectLines(index, index);
        }}
      >
        <span className="changes-line-no changes-line-old" aria-hidden="true">{line.oldLine ?? ""}</span>
        <span className="changes-line-no changes-line-new" aria-hidden="true">{line.newLine ?? ""}</span>
        <span className="changes-line-sign" aria-hidden="true">{line.sign}</span>
        <span className="changes-line-code" aria-hidden="true">
          <code className={className}>{syntax.length > 0 ? syntax : " "}</code>
          {line.noNewline && <span className="changes-eof-note">no newline at EOF</span>}
        </span>
      </div>
    );
  });
}

const syntaxComponents = {
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
  code: SyntaxReviewRows,
};

function lineLabel(line: ReviewLine): string {
  const kind = line.sign === "+" ? "Added" : line.sign === "-" ? "Deleted" : "Context";
  const coordinates = [
    line.oldLine === undefined ? undefined : `HEAD line ${line.oldLine}`,
    line.newLine === undefined ? undefined : `working tree line ${line.newLine}`,
  ].filter(Boolean);
  return `${kind}, ${coordinates.join(", ")}: ${line.text || "blank line"}${
    line.noNewline ? "; no newline at end of file" : ""
  }`;
}

export function ReviewRows({
  language,
  lines,
  selection,
  focusIndex,
  phone,
  rowRefs,
  dragAnchor,
  selectLines,
  setFocusIndex,
  onLineKey,
}: ReviewRowsValue & { language?: string }) {
  const source = useMemo(
    () => codeFence(lines.map((line) => line.text).join("\n"), language),
    [language, lines],
  );
  // Keep the parsed/highlighted Markdown subtree byte-stable while focus or
  // selection changes. Context updates the row chrome directly; it must not
  // rerun the syntax pipeline for every mouse-enter during a pointer drag.
  const highlighted = useMemo(
    () => (
      <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={syntaxComponents}>
        {source}
      </ReactMarkdown>
    ),
    [source],
  );
  const value = {
    lines,
    selection,
    focusIndex,
    phone,
    rowRefs,
    dragAnchor,
    selectLines,
    setFocusIndex,
    onLineKey,
  };
  return (
    <ReviewRowsContext.Provider value={value}>
      {highlighted}
    </ReviewRowsContext.Provider>
  );
}
