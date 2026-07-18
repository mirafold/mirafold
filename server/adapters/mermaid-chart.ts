// Mermaid xychart → chart component conversion (V.2's deterministic backstop).
//
// Codex's engine (gpt-5.6 family) has a strong learned preference for
// hand-writing ```mermaid xychart-beta``` blocks when asked for a chart — in
// ChatGPT surfaces those render as real charts, but in Mirafold a mermaid
// fence is literal code, so a chart request degrades to a code block. The
// first-turn guidance (RENDER_GUIDANCE + the deferred-tools addendum in
// codex.ts) makes the model call render_chart in every trial we ran, but the
// preference is the model's, not ours — so the adapter also converts any
// xychart fence it still emits into the real chart component, deterministically.
//
// Fail-open is the rule everywhere: anything this parser doesn't fully
// understand is left as the literal text the model wrote (faithful skin) —
// a wrong chart is worse than a code block.

/** Chart-component props (registry `chart` shape, registry-spec.ts). */
export interface ChartProps {
  title?: string;
  kind: "line" | "bar";
  x: string[];
  series: { name: string; values: number[] }[];
  yLabel?: string;
}

/** A run of ordinary text, or one converted chart, in document order. */
export type TextOrChart = { text: string } | { chart: ChartProps };

/** Strip one layer of matched quotes. */
const unquote = (s: string) => {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
};

/** Parse a `[a, b, c]` bracket list into trimmed, unquoted items. */
function bracketList(line: string): string[] | undefined {
  const m = line.match(/\[([\s\S]*)\]/);
  if (!m) return undefined;
  return m[1].split(",").map(unquote);
}

/**
 * Parse one mermaid `xychart-beta` body into chart props, or undefined if
 * anything about it falls outside the subset we can map faithfully:
 * x-axis must be a label list (numeric ranges have no label mapping), every
 * series must be numeric and exactly as long as the x axis. Mermaid series
 * carry no names, so series get the y-axis label (single) or "Series N".
 */
export function xychartToChart(body: string): ChartProps | undefined {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!/^xychart(-beta)?\b/.test(lines[0] ?? "")) return undefined;

  let title: string | undefined;
  let yLabel: string | undefined;
  let x: string[] | undefined;
  const raw: { kind: "line" | "bar"; values: number[] }[] = [];

  for (const line of lines.slice(1)) {
    if (line.startsWith("title ")) {
      title = unquote(line.slice("title ".length));
    } else if (line.startsWith("x-axis")) {
      x = bracketList(line);
      if (!x || x.length === 0) return undefined; // numeric-range or empty axis
    } else if (line.startsWith("y-axis")) {
      // `y-axis "Label" 0 --> 30` — keep the label, the component scales itself.
      const label = line.slice("y-axis".length).match(/"([^"]*)"|'([^']*)'/);
      if (label) yLabel = label[1] ?? label[2];
    } else if (/^(line|bar)\b/.test(line)) {
      const items = bracketList(line);
      if (!items) return undefined;
      const values = items.map(Number);
      if (values.some((v) => !Number.isFinite(v))) return undefined;
      raw.push({ kind: line.startsWith("line") ? "line" : "bar", values });
    }
    // anything else (comments, config) is ignorable noise
  }

  if (!x || raw.length === 0) return undefined;
  if (raw.some((s) => s.values.length !== x.length)) return undefined;

  // The model sometimes emits the same values as both `line` and `bar`
  // (observed live) — mermaid overlays them; our chart has one kind, so
  // duplicates collapse to the first.
  const series: { kind: "line" | "bar"; values: number[] }[] = [];
  for (const s of raw) {
    if (!series.some((t) => t.values.length === s.values.length && t.values.every((v, i) => v === s.values[i]))) {
      series.push(s);
    }
  }
  if (series.length > 6) return undefined; // registry cap; a 7-series chart is not ours to guess at

  return {
    ...(title ? { title } : {}),
    kind: series[0].kind,
    x,
    series: series.map((s, i) => ({
      name: series.length === 1 ? (yLabel ?? title ?? "Series 1") : `Series ${i + 1}`,
      values: s.values,
    })),
    ...(yLabel ? { yLabel } : {}),
  };
}

/**
 * Split an agent message into text runs and converted charts, in order.
 * Fences that aren't parseable xycharts stay embedded in the text untouched.
 * A message with nothing to convert comes back as one text segment.
 */
export function convertMermaidCharts(text: string): TextOrChart[] {
  const fence = /```mermaid[^\S\n]*\n([\s\S]*?)```/g;
  const out: TextOrChart[] = [];
  let cursor = 0;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    const chart = xychartToChart(m[1]);
    if (!chart) continue; // not ours — stays in the surrounding text
    const before = text.slice(cursor, m.index);
    if (before.trim()) out.push({ text: before });
    out.push({ chart });
    cursor = m.index + m[0].length;
  }
  if (out.length === 0) return [{ text }]; // nothing converted: hand back verbatim
  const after = text.slice(cursor);
  if (after.trim()) out.push({ text: after });
  return out;
}
