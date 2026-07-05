import { useState } from "react";

/**
 * Transcript record of one tool call: a dim monospace row, collapsed by
 * default — click to expand. The expansion shows the FULL input (T2.2) —
 * Edit/MultiEdit as a red/green line diff, Write as the new file's content,
 * everything else as pretty JSON — followed by the result. Errors arrive
 * expanded. While the result is pending the row pulses.
 */
export function ToolBlock({
  name,
  detail,
  input,
  output,
  isError,
}: {
  name: string;
  detail?: string;
  input?: Record<string, unknown>;
  output?: string;
  isError?: boolean;
}) {
  // null = user hasn't touched it; errors then default to open.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const running = output === undefined;
  const expanded = toggled ?? (!running && isError === true);

  return (
    <div
      className={`tool-block${isError ? " is-error" : ""}${running ? " is-running" : ""}`}
    >
      <button
        className="tool-head"
        onClick={() => setToggled(!expanded)}
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
            <pre className="tool-output">{output || "(no output)"}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Render a tool's input the way the terminal would: diffs for edits,
 *  code for writes, JSON for the rest. */
function ToolInput({ name, input }: { name: string; input: Record<string, unknown> }) {
  if ((name === "Edit" || name === "MultiEdit") && Array.isArray(input["edits"])) {
    // MultiEdit: a sequence of {old_string, new_string} edits.
    return (
      <div className="tool-input">
        {(input["edits"] as Record<string, unknown>[]).map((e, i) => (
          <Diff key={i} oldText={String(e["old_string"] ?? "")} newText={String(e["new_string"] ?? "")} />
        ))}
      </div>
    );
  }
  if (name === "Edit" && typeof input["old_string"] === "string") {
    return (
      <div className="tool-input">
        <Diff oldText={String(input["old_string"])} newText={String(input["new_string"] ?? "")} />
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

type DiffLine = { sign: " " | "-" | "+"; text: string };

/** Line-level diff via LCS — enough to read an Edit at a glance. */
function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ sign: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ sign: "-", text: a[i++] });
    } else {
      out.push({ sign: "+", text: b[j++] });
    }
  }
  while (i < n) out.push({ sign: "-", text: a[i++] });
  while (j < m) out.push({ sign: "+", text: b[j++] });
  return out;
}

function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = diffLines(oldText, newText);
  return (
    <pre className="tool-diff">
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.sign === "+" ? "diff-add" : l.sign === "-" ? "diff-del" : "diff-ctx"
          }
        >
          {l.sign} {l.text}
        </div>
      ))}
    </pre>
  );
}
