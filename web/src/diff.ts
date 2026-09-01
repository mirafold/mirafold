// Shared line differ: ToolBlock (Edit/Write inputs) and the registry's
// diff component render from the same output, so agent-painted diffs look
// exactly like tool-call diffs.

export type DiffLine = {
  sign: " " | "-" | "+";
  text: string;
  /** This side's source line is not terminated by `\n`. */
  noNewline?: true;
};

export function splitTextLines(text: string): { lines: string[]; endsWithNewline: boolean } {
  if (text === "") return { lines: [], endsWithNewline: false };
  const endsWithNewline = text.endsWith("\n");
  return {
    lines: (endsWithNewline ? text.slice(0, -1) : text).split("\n"),
    endsWithNewline,
  };
}

/** Largest changed-middle matrix the browser will allocate. Past this, an
 *  exact remove/add presentation is safer than freezing the main thread. */
export const DIFF_LCS_CELL_LIMIT = 1_000_000;

/** Line-level diff via LCS — enough to read an Edit at a glance. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldSource = splitTextLines(oldText);
  const newSource = splitTextLines(newText);
  const a = oldSource.lines;
  const b = newSource.lines;
  // Equal edges never need the matrix. Besides making ordinary edits much
  // cheaper, this leaves the large-input fallback focused on the changed
  // middle and preserves useful context around it.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const n = aEnd - start;
  const m = bEnd - start;
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ sign: " ", text }));

  // The fallback is byte-for-byte honest but intentionally non-minimal: all
  // old middle lines are removed and all new middle lines are added. It is
  // O(n+m) instead of allocating an attacker/model-sized n×m matrix. A
  // one-sided middle (pure insertion or deletion) always takes it — the
  // linear answer is exact there, and the matrix would still allocate a
  // row per line (PR #80 review).
  if (m === 0 || n === 0 || n > DIFF_LCS_CELL_LIMIT / m) {
    for (let i = start; i < aEnd; i++) out.push({ sign: "-", text: a[i] });
    for (let j = start; j < bEnd; j++) out.push({ sign: "+", text: b[j] });
    for (let i = aEnd; i < a.length; i++) out.push({ sign: " ", text: a[i] });
    return markNoNewline(out, oldSource.endsWithNewline, newSource.endsWithNewline);
  }

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[start + i] === b[start + j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      out.push({ sign: " ", text: a[start + i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ sign: "-", text: a[start + i++] });
    } else {
      out.push({ sign: "+", text: b[start + j++] });
    }
  }
  while (i < n) out.push({ sign: "-", text: a[start + i++] });
  while (j < m) out.push({ sign: "+", text: b[start + j++] });
  for (i = aEnd; i < a.length; i++) out.push({ sign: " ", text: a[i] });
  return markNoNewline(out, oldSource.endsWithNewline, newSource.endsWithNewline);
}

/** The `\ No newline at end of file` reconciliation, applied to the walked
 *  diff in place: tag each side's final source line when unterminated, and
 *  split the one shape the walk can't express — equal final text whose
 *  TERMINATION differs, which is a real one-line replacement, never a fake
 *  blank source line at N+1. */
function markNoNewline(
  out: DiffLine[],
  oldEndsWithNewline: boolean,
  newEndsWithNewline: boolean,
): DiffLine[] {
  const findLastSourceLine = (excluded: DiffLine["sign"]): number => {
    for (let index = out.length - 1; index >= 0; index -= 1) {
      if (out[index].sign !== excluded) return index;
    }
    return -1;
  };
  // A context line is only honest when BOTH sides' bytes agree, termination
  // included. Its per-side termination differs from the file flag only when
  // it is that side's final source line — and at most one of the two finals
  // can be context when they differ (everything past the smaller index is
  // single-signed). When the sides disagree, git splits it (`-x` + marker /
  // `+x`), and so must we: leaving it as context hides a real byte change
  // behind a "reviewed" mark.
  const oldLast = findLastSourceLine("+");
  const newLast = findLastSourceLine("-");
  const contextAt =
    out[oldLast]?.sign === " " ? oldLast : out[newLast]?.sign === " " ? newLast : -1;
  if (contextAt >= 0) {
    const oldTerminated = contextAt === oldLast ? oldEndsWithNewline : true;
    const newTerminated = contextAt === newLast ? newEndsWithNewline : true;
    if (oldTerminated !== newTerminated) {
      const text = out[contextAt].text;
      out.splice(
        contextAt,
        1,
        { sign: "-", text, ...(!oldTerminated ? { noNewline: true as const } : {}) },
        { sign: "+", text, ...(!newTerminated ? { noNewline: true as const } : {}) },
      );
    }
  }
  // Each side's final SIGNED source line carries its own marker — indices
  // recomputed, since the split above may have moved them.
  const oldFinal = findLastSourceLine("+");
  const newFinal = findLastSourceLine("-");
  if (oldFinal >= 0 && !oldEndsWithNewline && out[oldFinal].sign === "-") {
    out[oldFinal] = { ...out[oldFinal], noNewline: true };
  }
  if (newFinal >= 0 && !newEndsWithNewline && out[newFinal].sign === "+") {
    out[newFinal] = { ...out[newFinal], noNewline: true };
  }
  return out;
}

/**
 * Lines of a unified diff (what Codex reports per edited file) as DiffLine
 * rows, so an apply_patch row reads exactly like an Edit row. Hunk headers
 * (`@@ … @@`) become context rows; `\ No newline at end of file` marks the
 * preceding row. Anything else — a stray line without a sign — is shown as
 * context rather than dropped.
 */
export function unifiedDiffLines(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const raw of splitTextLines(diff).lines) {
    if (raw.startsWith("\\ No newline")) {
      if (out.length) out[out.length - 1].noNewline = true;
      continue;
    }
    // `--- file` / `+++ file` are headers only before the first hunk. Inside
    // a hunk, the same bytes mean source content beginning with `--` / `++`.
    if (!inHunk && (raw.startsWith("+++ ") || raw.startsWith("--- "))) continue;
    if (raw.startsWith("@@")) inHunk = true;
    const sign = raw[0];
    if (sign === "+" || sign === "-") out.push({ sign, text: raw.slice(1) });
    else if (sign === " ") out.push({ sign: " ", text: raw.slice(1) });
    else out.push({ sign: " ", text: raw });
  }
  return out;
}

/** A whole file as one-signed diff rows (an added or deleted file). */
export function wholeFileLines(content: string, sign: "+" | "-"): DiffLine[] {
  const { lines, endsWithNewline } = splitTextLines(content);
  return lines.map((text, i) => ({ sign, text, ...(i === lines.length - 1 && !endsWithNewline ? { noNewline: true as const } : {}) }));
}
