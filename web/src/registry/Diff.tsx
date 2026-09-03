import { Fragment } from "react";
import type { ComponentProps } from "@registry-spec";
import { diffLines, type DiffLine } from "../workspace/diff";

// Empty `before` means a new file and empty `after` a deletion — show pure
// +/- lines rather than diffing against the empty string's single "" line.
export function diffSnippet(before: string, after: string): DiffLine[] {
  return diffLines(before, after);
}

/** The one red/green line list both diff surfaces share (the registry diff
 *  component and ToolBlock's edit-input diff); the caller owns the <pre>. */
export function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <>
      {lines.map((l, i) => (
        <Fragment key={i}>
          <div
            className={l.sign === "+" ? "diff-add" : l.sign === "-" ? "diff-del" : "diff-ctx"}
          >
            {l.sign} {l.text}
          </div>
          {l.noNewline && <div className="diff-eof">\ No newline at end of file</div>}
        </Fragment>
      ))}
    </>
  );
}

export function Diff({ title, files }: ComponentProps<"diff">) {
  return (
    <div className="rc rc-diff">
      {title && <div className="rc-title">{title}</div>}
      {files.map((f, i) => (
        <div className="rc-diff-file" key={i}>
          <div className="rc-diff-path">
            <span>{f.path}</span>
            {f.note && <span className="rc-diff-note">{f.note}</span>}
          </div>
          <pre className="rc-diff-body">
            <DiffLines lines={diffSnippet(f.before, f.after)} />
          </pre>
        </div>
      ))}
    </div>
  );
}
