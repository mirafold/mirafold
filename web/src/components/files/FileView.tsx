import type { WireMsg } from "@protocol";
import { diffSnippet, DiffLines } from "../../registry/Diff";
import { formatBytes } from "../ToolBlock";

// The right pane of the Explorer: one file's content, or its git diff. A
// dumb presenter — useFileView owns the request/reply state and hands the
// resolved view down through whichever shell surface embeds it. Plain <pre>
// (the tool-code look), no syntax
// highlighting: file content matches tool output exactly, and diffs reuse
// the one red/green renderer ToolBlock and the registry diff share.

// diffLines is O(n·m); two 64 KB sides are ~2k×2k ≈ 4M cells — the ceiling a
// low-end phone can diff without a visible hang. Past it, skip the diff and
// show the after side plainly with a note.
const MAX_DIFF_CELLS = 4_000_000;

/** True when diffing before/after would exceed the LCS cell ceiling — the
 *  client-side guard against a hang on huge files (E.3). Pure, for Tier-1. */
export function diffTooLarge(before: string, after: string): boolean {
  const b = before === "" ? 0 : before.split("\n").length;
  const a = after === "" ? 0 : after.split("\n").length;
  return b * a > MAX_DIFF_CELLS;
}

export type FileViewState =
  | { kind: "empty" }
  | { kind: "loading"; path: string }
  | { kind: "error"; path: string; message: string }
  | { kind: "binary"; path: string; size?: number }
  | { kind: "content"; path: string; content: string; truncatedBytes?: number }
  | {
      kind: "diff";
      path: string;
      before: string;
      after: string;
      beforeTruncatedBytes?: number;
      afterTruncatedBytes?: number;
    };

/** Maps an fs_file reply onto the view state this file renders. */
export function fileToState(f: Extract<WireMsg, { type: "fs_file" }>): FileViewState {
  if (f.error) return { kind: "error", path: f.path, message: f.error };
  if (f.binary) return { kind: "binary", path: f.path, size: f.size };
  return {
    kind: "content",
    path: f.path,
    content: f.content ?? "",
    truncatedBytes: f.truncatedBytes,
  };
}

/** Maps an fs_file_diff reply onto the view state this file renders. */
export function diffToState(f: Extract<WireMsg, { type: "fs_file_diff" }>): FileViewState {
  if (f.error) return { kind: "error", path: f.path, message: f.error };
  if (f.binary) return { kind: "binary", path: f.path };
  return {
    kind: "diff",
    path: f.path,
    before: f.before ?? "",
    after: f.after ?? "",
    beforeTruncatedBytes: f.beforeTruncatedBytes,
    afterTruncatedBytes: f.afterTruncatedBytes,
  };
}

const elided = (bytes?: number) =>
  bytes ? <span className="fv-elided">{`⋯ ${formatBytes(bytes)} elided`}</span> : null;

export function FileView({ state }: { state: FileViewState }) {
  if (state.kind === "empty") {
    return <div className="fv-blank">Select a file to view it.</div>;
  }
  if (state.kind === "loading") {
    return <div className="fv-blank">Loading {state.path}…</div>;
  }
  if (state.kind === "error") {
    return (
      <div className="fv-blank fv-error">
        {state.path}: {state.message}
      </div>
    );
  }
  if (state.kind === "binary") {
    return (
      <div className="fv-blank">
        Binary file{state.size !== undefined ? ` (${formatBytes(state.size)})` : ""} — not shown.
      </div>
    );
  }
  if (state.kind === "content") {
    return (
      <pre className="tool-code fv-content">
        {state.content}
        {state.truncatedBytes ? (
          <>
            {"\n"}
            {elided(state.truncatedBytes)}
          </>
        ) : null}
      </pre>
    );
  }
  // diff
  const tooLarge = diffTooLarge(state.before, state.after);
  return (
    <>
      {(state.beforeTruncatedBytes || state.afterTruncatedBytes) && (
        <div className="fv-note">
          Diff is truncated{" "}
          {elided((state.beforeTruncatedBytes ?? 0) + (state.afterTruncatedBytes ?? 0))} — changes
          past the cap may be overstated.
        </div>
      )}
      {tooLarge ? (
        <>
          <div className="fv-note">File too large to diff — showing current contents.</div>
          <pre className="tool-code fv-content">{state.after}</pre>
        </>
      ) : (
        <pre className="tool-diff fv-content">
          <DiffLines lines={diffSnippet(state.before, state.after)} />
        </pre>
      )}
    </>
  );
}
