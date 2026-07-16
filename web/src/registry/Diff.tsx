import type { ComponentProps } from "@registry-spec";
import { diffLines, type DiffLine } from "../diff";

// Empty `before` means a new file and empty `after` a deletion — show pure
// +/- lines rather than diffing against the empty string's single "" line.
export function diffSnippet(before: string, after: string): DiffLine[] {
  if (before === "" && after === "") return [];
  if (before === "") return after.split("\n").map((text) => ({ sign: "+" as const, text }));
  if (after === "") return before.split("\n").map((text) => ({ sign: "-" as const, text }));
  return diffLines(before, after);
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
            {diffSnippet(f.before, f.after).map((l, j) => (
              <div
                key={j}
                className={l.sign === "+" ? "diff-add" : l.sign === "-" ? "diff-del" : "diff-ctx"}
              >
                {l.sign} {l.text}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}
