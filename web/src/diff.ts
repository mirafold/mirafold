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

  const findLastSourceLine = (excluded: DiffLine["sign"]): number => {
    for (let index = out.length - 1; index >= 0; index -= 1) {
      if (out[index].sign !== excluded) return index;
    }
    return -1;
  };
  const oldLast = findLastSourceLine("+");
  const newLast = findLastSourceLine("-");
  if (
    oldSource.endsWithNewline !== newSource.endsWithNewline &&
    oldLast >= 0 &&
    oldLast === newLast &&
    out[oldLast].sign === " "
  ) {
    // Equal final text with different termination is still a real one-line
    // replacement. A trailing split sentinel must never become a fake blank
    // source line with line number N+1.
    const text = out[oldLast].text;
    out.splice(
      oldLast,
      1,
      {
        sign: "-",
        text,
        ...(!oldSource.endsWithNewline ? { noNewline: true as const } : {}),
      },
      {
        sign: "+",
        text,
        ...(!newSource.endsWithNewline ? { noNewline: true as const } : {}),
      },
    );
  } else {
    if (
      oldLast >= 0 &&
      !oldSource.endsWithNewline &&
      out[oldLast].sign !== " "
    ) {
      out[oldLast] = { ...out[oldLast], noNewline: true };
    }
    if (
      newLast >= 0 &&
      !newSource.endsWithNewline &&
      out[newLast].sign !== " "
    ) {
      out[newLast] = { ...out[newLast], noNewline: true };
    }
  }
  return out;
}
