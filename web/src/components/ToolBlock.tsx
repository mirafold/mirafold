import { memo } from "react";
import type { ToolAction } from "@protocol";
import { diffLines, unifiedDiffLines, wholeFileLines, type DiffLine } from "../workspace/diff";
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
  const change = changeCounts(name, input);
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
      {!expanded && preview && (
        <pre className={`tool-preview${running ? " tool-preview-live" : ""}`} aria-hidden="true">
          {visibleControls(preview)}
        </pre>
      )}
      {expanded && (
        <div className="tool-body">
          {input && <ToolInput name={name} input={input} />}
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
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Inputs above this many characters IN TOTAL — or with more edits than this
// — are not counted: the badge is a glance, and diffing runs on every
// collapsed-row render (PR #120 review: a per-string guard let many large
// edits run the LCS each time).
const CHANGE_COUNT_MAX_CHARS = 200_000;
const CHANGE_COUNT_MAX_ITEMS = 200;

/** Lines added and removed by an edit-shaped call, from its own input —
 *  Edit/MultiEdit old/new strings, a Write's content, an apply_patch's
 *  diffs. Undefined for anything else, or an input too large to count. */
export function changeCounts(name: string, input?: Record<string, unknown>): { added: number; removed: number } | undefined {
  if (!input) return undefined;
  const count = (lines: DiffLine[]) => ({
    added: lines.filter((l) => l.sign === "+").length,
    removed: lines.filter((l) => l.sign === "-").length,
  });
  const within = (...texts: unknown[]) =>
    texts.reduce<number>((n, t) => n + (typeof t === "string" ? t.length : 0), 0) <= CHANGE_COUNT_MAX_CHARS;
  if ((name === "Edit" || name === "MultiEdit") && Array.isArray(input["edits"])) {
    const edits = (input["edits"] as unknown[]).map((raw) =>
      typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {},
    );
    if (edits.length > CHANGE_COUNT_MAX_ITEMS || !within(...edits.flatMap((e) => [e["old_string"], e["new_string"]]))) return undefined;
    let added = 0;
    let removed = 0;
    for (const e of edits) {
      const c = count(diffLines(String(e["old_string"] ?? ""), String(e["new_string"] ?? "")));
      added += c.added;
      removed += c.removed;
    }
    return { added, removed };
  }
  if (name === "Edit" && typeof input["old_string"] === "string") {
    if (!within(input["old_string"], input["new_string"])) return undefined;
    return count(diffLines(input["old_string"], String(input["new_string"] ?? "")));
  }
  if (name === "Write" && typeof input["content"] === "string") {
    if (!within(input["content"])) return undefined;
    return { added: input["content"] ? input["content"].split("\n").length : 0, removed: 0 };
  }
  if (name === "apply_patch" && Array.isArray(input["changes"])) {
    const changes = (input["changes"] as unknown[]).map((raw) =>
      typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {},
    );
    if (changes.length > CHANGE_COUNT_MAX_ITEMS || !within(...changes.map((c) => c["diff"]))) return undefined;
    let added = 0;
    let removed = 0;
    for (const c of changes) {
      const kind = c["kind"] === "add" || c["kind"] === "delete" ? (c["kind"] as "add" | "delete") : "update";
      const diff = typeof c["diff"] === "string" ? c["diff"] : "";
      const counted = count(kind === "update" ? unifiedDiffLines(diff) : wholeFileLines(diff, kind === "add" ? "+" : "-"));
      added += counted.added;
      removed += counted.removed;
    }
    return { added, removed };
  }
  return undefined;
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
  if (name === "apply_patch" && Array.isArray(input["changes"])) {
    // Codex edits: one block per changed file, the patch drawn as diff rows
    // (hunks for updates, the whole file for adds/deletes) — what the
    // terminal prints for apply_patch.
    return (
      <div className="tool-input">
        {(input["changes"] as unknown[]).map((raw, i) => {
          const c = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
          const kind = c["kind"] === "add" || c["kind"] === "delete" ? (c["kind"] as "add" | "delete") : "update";
          const diff = typeof c["diff"] === "string" ? c["diff"] : "";
          const shownPath = String(c["path"] ?? "");
          const movePath = typeof c["movePath"] === "string" ? c["movePath"] : undefined;
          const label = movePath
            ? `Moved ${shownPath} → ${movePath}`
            : `${kind === "add" ? "Added" : kind === "delete" ? "Deleted" : "Updated"} ${shownPath}`;
          const lines: DiffLine[] = kind === "update" ? unifiedDiffLines(diff) : wholeFileLines(diff, kind === "add" ? "+" : "-");
          return (
            <div className="tool-patch" key={i}>
              {/* Marked but deliberately not length-clamped: truncating the
                  path would hide exactly what this row exists to audit, and
                  the diff body below it is already unbounded model content. */}
              <div className="tool-patch-path">{visibleControls(label)}</div>
              {lines.length > 0 ? (
                <pre className="tool-diff">
                  <DiffLines lines={lines} />
                </pre>
              ) : (
                <pre className="tool-code">(no diff)</pre>
              )}
            </div>
          );
        })}
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
