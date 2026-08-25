import { memo } from "react";
import { diffLines } from "../diff";
import { DiffLines } from "../registry/Diff";

/**
 * Transcript record of one tool call: a dim monospace row, collapsed by
 * default — click to expand. The expansion shows the FULL input —
 * Edit/MultiEdit as a red/green line diff, Write as the new file's content,
 * everything else as pretty JSON — followed by the result. Errors arrive
 * expanded. While the result is pending the row pulses. Disclosure is
 * CONTROLLED (`toggled` + `onToggle`, owned by the output zone): a row that
 * finishes and moves into a live fold remounts, and a user's expand must
 * survive that move.
 */
export const ToolBlock = memo(function ToolBlock({
  id,
  name,
  detail,
  input,
  output,
  truncatedBytes,
  isError,
  toggled,
  onToggle,
}: {
  id: number;
  name: string;
  detail?: string;
  input?: Record<string, unknown>;
  output?: string;
  truncatedBytes?: number;
  isError?: boolean;
  /** null = user hasn't touched it; errors then default to open. */
  toggled: boolean | null;
  onToggle: (id: number, expanded: boolean) => void;
}) {
  const running = output === undefined;
  const expanded = toggled ?? (!running && isError === true);

  return (
    <div
      className={`tool-block${isError ? " is-error" : ""}${running ? " is-running" : ""}`}
    >
      <button
        className="tool-head"
        onClick={() => onToggle(id, !expanded)}
        title={expanded ? "Collapse" : "Expand"}
      >
        <span className="tool-caret">{running ? "•" : expanded ? "▾" : "▸"}</span>
        <span className="tool-name">{name}</span>
        {detail && <span className="tool-detail">{detail}</span>}
      </button>
      {expanded && (
        <div className="tool-body">
          {input && <ToolInput name={name} input={input} />}
          {!running && (
            <pre className="tool-output">
              {output || "(no output)"}
              {truncatedBytes ? (
                <span className="tool-elided">
                  {"\n⋯ "}
                  {formatBytes(truncatedBytes)} elided
                </span>
              ) : null}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render a tool's input the way the terminal would: diffs for edits,
 *  code for writes, JSON for the rest. */
function ToolInput({ name, input }: { name: string; input: Record<string, unknown> }) {
  if ((name === "Edit" || name === "MultiEdit") && Array.isArray(input["edits"])) {
    // MultiEdit: a sequence of {old_string, new_string} edits.
    return (
      <div className="tool-input">
        {(input["edits"] as unknown[]).map((raw, i) => {
          // Engine-authored input: each element is checked, not assumed.
          const e = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
          return (
            <EditDiff key={i} oldText={String(e["old_string"] ?? "")} newText={String(e["new_string"] ?? "")} />
          );
        })}
      </div>
    );
  }
  if (name === "Edit" && typeof input["old_string"] === "string") {
    return (
      <div className="tool-input">
        <EditDiff oldText={String(input["old_string"])} newText={String(input["new_string"] ?? "")} />
      </div>
    );
  }
  if (name === "Write" && typeof input["content"] === "string") {
    return (
      <div className="tool-input">
        <pre className="tool-code tool-added">{String(input["content"])}</pre>
      </div>
    );
  }
  return (
    <div className="tool-input">
      <pre className="tool-code">{JSON.stringify(input, null, 2)}</pre>
    </div>
  );
}

function EditDiff({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <pre className="tool-diff">
      <DiffLines lines={diffLines(oldText, newText)} />
    </pre>
  );
}
