import { useState } from "react";

/**
 * Transcript record of one tool call: a dim monospace row, collapsed by
 * default — click to expand the output. Errors arrive expanded. While the
 * result is pending the row pulses and can't be toggled.
 */
export function ToolBlock({
  name,
  detail,
  output,
  isError,
}: {
  name: string;
  detail?: string;
  output?: string;
  isError?: boolean;
}) {
  // null = user hasn't touched it; errors then default to open.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const running = output === undefined;
  const expanded = !running && (toggled ?? isError === true);

  return (
    <div
      className={`tool-block${isError ? " is-error" : ""}${running ? " is-running" : ""}`}
    >
      <button
        className="tool-head"
        onClick={() => !running && setToggled(!expanded)}
        title={running ? "running…" : expanded ? "Collapse output" : "Expand output"}
      >
        <span className="tool-caret">{running ? "•" : expanded ? "▾" : "▸"}</span>
        <span className="tool-name">{name}</span>
        {detail && <span className="tool-detail">{detail}</span>}
      </button>
      {expanded && <pre className="tool-output">{output || "(no output)"}</pre>}
    </div>
  );
}
