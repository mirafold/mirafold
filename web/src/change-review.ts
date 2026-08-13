import { diffLines, splitTextLines, type DiffLine } from "./diff";
import { codeFence } from "./registry/Code";

export const MAX_REVIEW_SELECTION = 80;
export const MAX_INTERACTIVE_REVIEW_LINES = 1_000;

export type ReviewLine = DiffLine & {
  id: string;
  index: number;
  oldLine?: number;
  newLine?: number;
};

export type ReviewHunk = {
  id: string;
  start: number;
  end: number;
};

type ReviewSelection = {
  anchor: number;
  focus: number;
  start: number;
  end: number;
  clamped: boolean;
};

export type VersionedReviewSelection = ReviewSelection & {
  path: string;
  before: string;
  after: string;
};

/** Bound the DOM/highlighting cost before constructing the LCS diff. One
 * changed line can otherwise turn a many-thousand-line file into thousands
 * of ReactMarkdown/highlight instances even when the matrix itself is cheap
 * (notably added/deleted files, where one side is empty). */
export function interactiveReviewTooLarge(
  before: string,
  after: string,
  maxLines = MAX_INTERACTIVE_REVIEW_LINES,
): boolean {
  const beforeLines = splitTextLines(before).lines.length;
  const afterLines = splitTextLines(after).lines.length;
  return beforeLines + afterLines > maxLines;
}

export const reviewScrollBehavior = (prefersReducedMotion: boolean): ScrollBehavior =>
  prefersReducedMotion ? "auto" : "smooth";

/** Add stable source coordinates to the shared line diff. Line ids are tied
 * to their HEAD/current coordinates rather than their rendered array offset. */
export function reviewLines(before: string, after: string): ReviewLine[] {
  let oldLine = 0;
  let newLine = 0;
  return diffLines(before, after).map((line, index) => {
    const oldAt = line.sign === "+" ? undefined : ++oldLine;
    const newAt = line.sign === "-" ? undefined : ++newLine;
    return {
      ...line,
      index,
      oldLine: oldAt,
      newLine: newAt,
      id: `${line.sign}:${oldAt ?? ""}:${newAt ?? ""}`,
    };
  });
}

/** Consecutive edits separated by at most six unchanged lines read as one
 * review hunk. Outer context stays fully visible, so navigation never hides
 * the containing function or requires an expansion gesture. */
export function reviewHunks(lines: readonly ReviewLine[]): ReviewHunk[] {
  const changed = lines.filter((line) => line.sign !== " ").map((line) => line.index);
  if (changed.length === 0) return [];

  const hunks: ReviewHunk[] = [];
  let start = changed[0];
  let end = changed[0];
  for (const index of changed.slice(1)) {
    if (index - end <= 7) {
      end = index;
      continue;
    }
    hunks.push({ id: `hunk-${lines[start].id}`, start, end });
    start = index;
    end = index;
  }
  hunks.push({ id: `hunk-${lines[start].id}`, start, end });
  return hunks;
}

export function closestHunk(hunks: readonly ReviewHunk[], lineIndex: number): number {
  if (hunks.length === 0) return -1;
  const containing = hunks.findIndex((hunk) => lineIndex >= hunk.start && lineIndex <= hunk.end);
  if (containing >= 0) return containing;
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  hunks.forEach((hunk, index) => {
    const next = Math.min(Math.abs(lineIndex - hunk.start), Math.abs(lineIndex - hunk.end));
    if (next < distance) {
      best = index;
      distance = next;
    }
  });
  return best;
}

export function reviewSelection(
  anchor: number,
  focus: number,
  lineCount: number,
  maxLines = MAX_REVIEW_SELECTION,
): ReviewSelection | undefined {
  if (lineCount <= 0 || maxLines <= 0) return undefined;
  const safeAnchor = Math.max(0, Math.min(lineCount - 1, anchor));
  const requestedFocus = Math.max(0, Math.min(lineCount - 1, focus));
  const direction = requestedFocus < safeAnchor ? -1 : 1;
  const furthest = safeAnchor + direction * (maxLines - 1);
  const safeFocus =
    direction < 0
      ? Math.max(requestedFocus, Math.max(0, furthest))
      : Math.min(requestedFocus, Math.min(lineCount - 1, furthest));
  return {
    anchor: safeAnchor,
    focus: safeFocus,
    start: Math.min(safeAnchor, safeFocus),
    end: Math.max(safeAnchor, safeFocus),
    clamped: safeFocus !== requestedFocus,
  };
}

function sourceRange(label: string, values: number[]): string | undefined {
  if (values.length === 0) return undefined;
  const start = Math.min(...values);
  const end = Math.max(...values);
  return start === end ? `${label} line ${start}` : `${label} lines ${start}–${end}`;
}

export function formatReviewDraft(
  intent: "explain" | "request-change",
  path: string,
  lines: readonly ReviewLine[],
): string {
  if (lines.length === 0) return "";
  const ranges = [
    sourceRange("HEAD", lines.flatMap((line) => (line.oldLine === undefined ? [] : [line.oldLine]))),
    sourceRange(
      "working tree",
      lines.flatMap((line) => (line.newLine === undefined ? [] : [line.newLine])),
    ),
  ].filter((range): range is string => Boolean(range));
  const snippet = lines
    .map(
      (line) =>
        `${line.sign} ${line.text}${line.noNewline ? "\n\\ No newline at end of file" : ""}`,
    )
    .join("\n");
  const instruction =
    intent === "explain"
      ? "Explain the selected workspace change."
      : "Please revise the selected workspace change.";
  return [
    instruction,
    `File: ${JSON.stringify(path)}`,
    `Range: ${ranges.join("; ")}`,
    "",
    "Selected diff:",
    codeFence(snippet, "diff"),
  ].join("\n");
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "xml",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mjs: "javascript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function languageForPath(path: string): string | undefined {
  const leaf = path.split("/").pop()?.toLowerCase() ?? "";
  if (leaf === "dockerfile") return "dockerfile";
  if (leaf === "makefile") return "makefile";
  const dot = leaf.lastIndexOf(".");
  return dot >= 0 ? LANGUAGE_BY_EXTENSION[leaf.slice(dot + 1)] : undefined;
}
