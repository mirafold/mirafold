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

/** Line-level diff via LCS — enough to read an Edit at a glance. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldSource = splitTextLines(oldText);
  const newSource = splitTextLines(newText);
  const a = oldSource.lines;
  const b = newSource.lines;
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
  // behind a "reviewed" mark (bughunt 2026-08-13 — the old code split only
  // the oldLast === newLast case).
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
