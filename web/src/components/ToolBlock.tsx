import { memo, useMemo } from "react";
import type { ToolAction } from "@protocol";
import { prepareEditInput, editPreview, type EditInput, type EditFile } from "./edit-input";
import { visibleControls } from "../visible-controls";
import { DiffLines } from "../registry/Diff";
import type { LiveOutputView } from "../transcript/transcript-projection";

/** How many trailing lines a collapsed command row previews (R3). */
export const PREVIEW_LINES = 3;

/**
 * Transcript record of one tool call: a dim monospace row — the call, its
 * state (running / exit N / duration), and for a command a bounded preview
 * of its last lines — collapsed by default; click to expand. The expansion
 * shows the FULL input — Edit/MultiEdit as a red/green line diff, Write as
 * the new file's content, everything else as pretty JSON — followed by the
 * retained result: the head, an honest note of what was omitted, the tail.
 * Errors arrive expanded. While the result is pending the row pulses.
 * Disclosure is CONTROLLED (`expanded` + `onToggle`, keyed by wire
 * identity in the output zone): a row that finishes and moves into a group
 * remounts, and a reader's expand must survive that move.
 */
export const ToolBlock = memo(function ToolBlock({
  toggleKey,
  name,
  detail,
  input,
  output,
  tail,
  omittedBytes,
  truncatedBytes,
  isError,
  exitCode,
  durationMs,
  elapsedMs,
  actions,
  streamed,
  live,
  orphaned,
  expanded,
  previewDefault = false,
  onToggle,
  liveOutputAvailable,
}: {
  toggleKey: string;
  name: string;
  detail?: string;
  input?: Record<string, unknown>;
  output?: string;
  tail?: string;
  omittedBytes?: number;
  truncatedBytes?: number;
  isError?: boolean;
  exitCode?: number;
  durationMs?: number;
  elapsedMs?: number;
  actions?: ToolAction[];
  /** Output streamed while the call runs — the legacy prefix. */
  streamed?: string;
  /** The newest bounded replacement snapshot while the call runs. */
  live?: LiveOutputView;
  /** A result whose announcing call was never retained. */
  orphaned?: boolean;
  expanded: boolean;
  /** Untouched compact disclosure; an explicit collapse hides the preview. */
  previewDefault?: boolean;
  onToggle: (key: string, expanded: boolean) => void;
  /** Whether this session's agent ever streams a running call's output —
   *  undefined when the daemon did not say. Decides what silence means. */
  liveOutputAvailable?: boolean;
}) {
  const running = output === undefined;
  const liveText = live ? live.head + (live.tail ? `\n${live.tail}` : "") : streamed;
  // A routine read/listing/search previews nothing: its row is the fact.
  // A command shows its last lines so the outcome is on the row (R3).
  const previewSource = running ? liveText : tail ?? output;
  const preview = !actions?.length && previewSource ? lastLines(previewSource, PREVIEW_LINES) : "";
  const prepared = useMemo(() => prepareEditInput(name, input), [name, input]);
  const edit = useMemo(() => prepared ? editPreview(prepared) : undefined, [prepared]);
  const succeeded = !running && !isError && (exitCode === undefined || exitCode === 0);
  const change = succeeded ? prepared?.counts : undefined;
  const showEdit = !expanded && previewDefault && succeeded && prepared && edit;

  const state = running
    ? elapsedMs !== undefined
      ? `running · ${formatDuration(elapsedMs)}`
      : "running"
    : undefined;

  return (
    <div
      className={`tool-block${isError ? " is-error" : ""}${running ? " is-running" : ""}${orphaned ? " is-orphaned" : ""}${exitCode !== undefined && exitCode !== 0 ? " has-exit" : ""}`}
    >
      <button
        className="tool-head"
        onClick={() => onToggle(toggleKey, !expanded)}
        aria-expanded={expanded}
        title={expanded ? "Hide this call's details" : "Show this call's details"}
      >
        <span className="tool-caret" aria-hidden="true">{running ? "•" : expanded ? "▾" : "▸"}</span>
        <span className="tool-name">{visibleControls(name)}</span>
        {detail && <span className="tool-detail">{visibleControls(detail)}</span>}
        {change && (
          <span className="tool-change" title="lines added / removed">
            {change.added > 0 && <span className="tool-change-add">+{change.added}</span>}
            {change.removed > 0 && <span className="tool-change-del">−{change.removed}</span>}
          </span>
        )}
        {state && <span className="tool-state">{state}</span>}
        {!running && exitCode !== undefined && exitCode !== 0 && (
          <span className="tool-exit" title="the command's own exit status">exit {exitCode}</span>
        )}
        {!running && durationMs !== undefined && (
          <span className="tool-duration" title="duration reported by the engine">{formatDuration(durationMs)}</span>
        )}
      </button>
      {showEdit && (
        <div className="tool-edit-preview">
          {edit.files.map((file, i) => <EditFileView key={i} file={file} applied />)}
          <div className="tool-edit-more">
            {prepared.unavailable ?? (edit.omitted ? "Preview shortened" : edit.files.length ? "" : "No textual change")}
            <button onClick={() => onToggle(toggleKey, true)}>Show full details</button>
            <button onClick={() => onToggle(toggleKey, false)}>Hide preview</button>
          </div>
        </div>
      )}
      {!expanded && !showEdit && preview && (
        <pre className={`tool-preview${running ? " tool-preview-live" : ""}`} aria-hidden="true">
          {visibleControls(preview)}
        </pre>
      )}
      {expanded && (
        <div className="tool-body">
          {input && <ToolInput input={input} prepared={prepared} applied={succeeded} />}
          {running && (
            <RunningOutput live={live} streamed={streamed} liveOutputAvailable={liveOutputAvailable} />
          )}
          {!running && (
            <pre className="tool-output">
              {output || (tail ? "" : omittedBytes ? "" : "(no output)")}
              <Omission omittedBytes={omittedBytes} truncatedBytes={truncatedBytes} hasTail={tail !== undefined} />
              {tail}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

/** What a running call's expansion shows: the newest snapshot (head,
 *  omission, tail), else the legacy prefix, else an honest word about the
 *  silence — which depends on whether this agent ever streams output. */
function RunningOutput({
  live,
  streamed,
  liveOutputAvailable,
}: {
  live?: LiveOutputView;
  streamed?: string;
  liveOutputAvailable?: boolean;
}) {
  if (live) {
    return (
      <pre className="tool-output tool-output-live">
        {live.head}
        <Omission omittedBytes={live.omittedBytes} hasTail={live.tail !== undefined} />
        {live.tail}
      </pre>
    );
  }
  if (streamed) return <pre className="tool-output tool-output-live">{streamed}</pre>;
  return (
    <div className="tool-silent">
      {liveOutputAvailable === false
        ? "live output unavailable for this agent — the result arrives when the call completes"
        : "no output received yet"}
    </div>
  );
}

/** The explicit marker for what the wire did not keep: a head/tail result
 *  names the omitted middle; a prefix-only result (an older daemon) names
 *  what was cut after the head; a zero-budget result says nothing was kept. */
function Omission({
  omittedBytes,
  truncatedBytes,
  hasTail,
}: {
  omittedBytes?: number;
  truncatedBytes?: number;
  hasTail: boolean;
}) {
  if (omittedBytes !== undefined) {
    if (omittedBytes === 0) return null;
    return (
      <span className="tool-elided">
        {hasTail ? "\n⋯ " : "\n⋯ "}
        {formatBytes(omittedBytes)} {hasTail ? "omitted between head and tail" : "not retained"} ⋯{hasTail ? "\n" : ""}
      </span>
    );
  }
  if (truncatedBytes) {
    return (
      <span className="tool-elided">
        {"\n⋯ "}
        {formatBytes(truncatedBytes)} elided
      </span>
    );
  }
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  // Round the whole duration to seconds first so a remainder never carries
  // into "1m 60s" (round 3).
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** Counts and preview share one preparation in the mounted row. */
export function changeCounts(name: string, input?: Record<string, unknown>): { added: number; removed: number } | undefined {
  return prepareEditInput(name, input)?.counts;
}

function EditFileView({ file, applied }: { file: EditFile; applied: boolean }) {
  const label = applied ? file.label : file.label
    .replace(/^Written content · /, "Write input · ")
    .replace(/^Updated /, "Update input · ")
    .replace(/^Added /, "Add input · ")
    .replace(/^Deleted /, "Delete input · ")
    .replace(/^Moved /, "Move input · ");
  return (
    <div className="tool-patch">
      <div className="tool-patch-path">{visibleControls(label)}</div>
      {file.lines.length ? (
        <pre className={file.written ? "tool-code" : "tool-diff"} tabIndex={0} aria-label={visibleControls(label)}>
          {file.written
            ? file.lines.map((line, i) => <div key={i}>{line.text}{line.noNewline && <span className="diff-eof"> (no final newline)</span>}</div>)
            : <DiffLines lines={file.lines} />}
        </pre>
      ) : <pre className="tool-code">(no diff)</pre>}
    </div>
  );
}

function ToolInput({ input, prepared, applied }: { input: Record<string, unknown>; prepared?: EditInput; applied: boolean }) {
  return (
    <div className="tool-input">
      {prepared && !prepared.unavailable ? <>
        {prepared.files.map((file, i) => <EditFileView key={i} file={file} applied={applied} />)}
        <details className="tool-parameters"><summary>Original input</summary><pre className="tool-code">{visibleControls(JSON.stringify(input, null, 2))}</pre></details>
      </> : <pre className="tool-code">{visibleControls(JSON.stringify(input, null, 2))}</pre>}
    </div>
  );
}

/** The last non-empty line of streamed output, capped, for a one-line head. */
export function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  const line = lines[lines.length - 1] ?? "";
  return line.length > 80 ? `…${line.slice(-79)}` : line;
}

/** The last `count` non-empty lines of a text, each capped at 200 chars —
 *  the bounded preview a collapsed command row carries (R3). */
export function lastLines(text: string, count: number): string {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  return lines
    .slice(-count)
    .map((line) => (line.length > 200 ? `…${line.slice(-199)}` : line))
    .join("\n");
}
