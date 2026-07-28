import { useState } from "react";
import type { ComponentProps } from "@registry-spec";

// Categorical palette validated (dataviz six-checks) against the app's dark
// surface #141a26 — fixed slot order is the CVD-safety mechanism, never cycle
// or reorder it. Adjacent-pair CVD sits in the floor band, so ≥2-series
// charts always carry secondary encoding: legend + tooltip + end labels.
// Mid-luminance slots hold up on the light theme too (4.3); axis/grid inks
// come from the theme tokens via style (SVG attributes can't carry var()).
const COLORS = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767"];
const SURFACE = { stroke: "var(--surface)" };
const GRID = { stroke: "var(--border-faint)" };
const INK_MUTED = { fill: "var(--fg-dim)" };
const INK = { fill: "var(--fg-mid)" };

const seriesColor = (i: number) => COLORS[i % COLORS.length];

const dimUnlessHovered = (hover: number | null, i: number) =>
  hover === null || hover === i ? 1 : 0.45;

const elide = (label: string, max: number) =>
  label.length > max ? label.slice(0, max - 1) + "…" : label;

const W = 640;
const H = 260;
const PAD = { top: 16, right: 118, bottom: 28, left: 48 };

export function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = mag * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10);
  const lo = Math.floor(min / step) * step;
  const out: number[] = [];
  // The top tick must clear the data max so no mark escapes the plot area.
  for (let v = lo; ; v += step) {
    out.push(Math.round(v * 1e9) / 1e9);
    if (v >= max) break;
  }
  return out;
}

export const fmt = (v: number): string =>
  Math.abs(v) >= 1e6
    ? `${+(v / 1e6).toFixed(1)}M`
    : Math.abs(v) >= 1e3
      ? `${+(v / 1e3).toFixed(1)}k`
      : `${+v.toFixed(2)}`;

/** Bar with a 4px-rounded data end, anchored flat to the baseline. */
function barPath(bx: number, vy: number, w: number, y0: number): string {
  const r = Math.min(4, w / 2, Math.abs(y0 - vy));
  if (vy <= y0) {
    // positive bar: rounded top
    return `M${bx},${y0} V${vy + r} Q${bx},${vy} ${bx + r},${vy} H${bx + w - r} Q${bx + w},${vy} ${bx + w},${vy + r} V${y0} Z`;
  }
  // negative bar: rounded bottom
  return `M${bx},${y0} V${vy - r} Q${bx},${vy} ${bx + r},${vy} H${bx + w - r} Q${bx + w},${vy} ${bx + w},${vy - r} V${y0} Z`;
}

/** Horizontal bar: grows rightward, 4px-rounded data end on the right. */
function hBarPath(by: number, vx: number, h: number, x0: number): string {
  const r = Math.min(4, h / 2, Math.abs(vx - x0));
  return `M${x0},${by} H${vx - r} Q${vx},${by} ${vx},${by + r} V${by + h - r} Q${vx},${by + h} ${vx - r},${by + h} H${x0} Z`;
}

export type PieSlice = { label: string; value: number; frac: number };

/** Slices ordered by size, the rest folded into one "other" — at most `max`
 *  segments, so the fixed-slot palette always suffices (slot order is the CVD
 *  mechanism; never cycle it). Non-finite and non-positive values are dropped:
 *  a pie has no geometry for them. Pure, for Tier-1. */
export function pieSlices(x: string[], values: number[], max = 6): PieSlice[] {
  const entries = x
    .map((label, i) => ({ label, value: values[i] }))
    .filter((e) => Number.isFinite(e.value) && e.value > 0)
    .sort((a, b) => b.value - a.value);
  const kept = entries.length <= max ? entries : entries.slice(0, max - 1);
  const rest = entries.slice(kept.length);
  const slices = rest.length
    ? [...kept, { label: "other", value: rest.reduce((sum, e) => sum + e.value, 0) }]
    : kept;
  const total = slices.reduce((sum, e) => sum + e.value, 0);
  return slices.map((s) => ({ ...s, frac: s.value / total }));
}

/** One donut segment; angles in radians from 12 o'clock, clockwise. A lone
 *  full-circle slice is clamped a hair short of 2π — an SVG arc pair cannot
 *  draw a closed circle. Pure, for Tier-1. */
export function arcPath(
  cx: number,
  cy: number,
  rOut: number,
  rIn: number,
  a0: number,
  a1: number,
): string {
  const sweep = Math.min(a1 - a0, 2 * Math.PI - 1e-4);
  const end = a0 + sweep;
  const large = sweep > Math.PI ? 1 : 0;
  const pt = (r: number, a: number) =>
    `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
  return (
    `M${pt(rOut, a0)} A${rOut},${rOut} 0 ${large} 1 ${pt(rOut, end)} ` +
    `L${pt(rIn, end)} A${rIn},${rIn} 0 ${large} 0 ${pt(rIn, a0)} Z`
  );
}

export type StackSeg = { si: number; v: number; lo: number; hi: number };

/** Per-x cumulative spans for stacked bars, in series (palette-slot) order.
 *  Only positive finite values stack — a negative segment has no stacking
 *  geometry, so it's dropped rather than drawn misleadingly. Pure, for Tier-1. */
export function stackSegments(series: { values: number[] }[], xLen: number): StackSeg[][] {
  return Array.from({ length: xLen }, (_, i) => {
    let acc = 0;
    const col: StackSeg[] = [];
    series.forEach((s, si) => {
      const v = s.values[i];
      if (Number.isFinite(v) && v > 0) {
        col.push({ si, v, lo: acc, hi: acc + v });
        acc += v;
      }
    });
    return col;
  });
}

function Legend({ series }: { series: ComponentProps<"chart">["series"] }) {
  return (
    <div className="rc-chart-legend">
      {series.map((s, i) => (
        <span key={i} className="rc-chart-key">
          <span className="rc-chart-chip" style={{ background: seriesColor(i) }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

/** The tooltip's shared body — hovered category, then one row per finite
 *  series value. Each caller keeps its own positioned wrapper div. */
function TipRows({
  x,
  series,
  yLabel,
  hover,
}: {
  x: string[];
  series: ComponentProps<"chart">["series"];
  yLabel?: string;
  hover: number;
}) {
  return (
    <>
      <div className="rc-chart-tip-x">{x[hover]}</div>
      {series.map((s, si) =>
        Number.isFinite(s.values[hover]) ? (
          <div key={si} className="rc-chart-tip-row">
            <span className="rc-chart-chip" style={{ background: seriesColor(si) }} />
            <span className="rc-chart-tip-name">{s.name}</span>
            <span className="rc-chart-tip-val">
              {fmt(s.values[hover])}
              {yLabel ? ` ${yLabel}` : ""}
            </span>
          </div>
        ) : null,
      )}
    </>
  );
}

export function Chart(props: ComponentProps<"chart">) {
  if (props.kind === "pie") {
    // The one-series rule is part of the vocabulary (the schema's describe
    // says so); a violated pie must not guess which series to draw. Throwing
    // routes into RenderBlock's error boundary → the legible raw-props
    // fallback — the designed degradation (PLAN S.1), not a crash.
    if (props.series.length !== 1) throw new Error("pie requires exactly one series");
    return <PieChart {...props} />;
  }
  if (props.kind === "bar" && props.horizontal) return <HBarChart {...props} />;
  return <VChart {...props} />;
}

function PieChart({ title, x, series }: ComponentProps<"chart">) {
  const [hover, setHover] = useState<number | null>(null);
  const slices = pieSlices(x, series[0].values);
  if (slices.length === 0) throw new Error("pie needs at least one positive value");
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const cx = 132;
  const cy = H / 2;
  let acc = 0;
  const segs = slices.map((s) => {
    const a0 = acc;
    acc += s.frac * 2 * Math.PI;
    return { ...s, a0, a1: acc };
  });
  const rowY = (i: number) => (H - segs.length * 22) / 2 + i * 22 + 12;
  const share = (frac: number) => `${Math.round(frac * 100)}%`;
  return (
    <div className="rc rc-chart">
      {title && <div className="rc-title">{title}</div>}
      <div className="rc-chart-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title ?? "pie chart"}>
          {segs.map((s, i) => (
            <path
              key={i}
              className="rc-chart-slice"
              d={arcPath(cx, cy, 92, 56, s.a0, s.a1)}
              fill={seriesColor(i)}
              style={SURFACE}
              strokeWidth="2"
              opacity={dimUnlessHovered(hover, i)}
              onMouseEnter={() => setHover(i)}
            >
              <title>{`${s.label}: ${fmt(s.value)} (${share(s.frac)})`}</title>
            </path>
          ))}
          {/* the donut hole carries the total — the whole the parts are of */}
          <text x={cx} y={cy - 2} textAnchor="middle" fontSize="17" fontWeight="600" style={INK}>
            {fmt(total)}
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle" fontSize="10" style={INK_MUTED}>
            total
          </text>
          {/* direct labels: every slice named with its value + share — never
              color-alone, and no around-the-donut collisions by construction */}
          {segs.map((s, i) => (
            <g
              key={i}
              opacity={dimUnlessHovered(hover, i)}
              onMouseEnter={() => setHover(i)}
            >
              <rect x={266} y={rowY(i) - 8} width={10} height={10} rx={2} fill={seriesColor(i)} />
              <text x={283} y={rowY(i) + 1} fontSize="11" style={INK}>
                {elide(s.label, 24)}
              </text>
              <text x={W - 24} y={rowY(i) + 1} textAnchor="end" fontSize="11" style={INK_MUTED}>
                {fmt(s.value)} · {share(s.frac)}
              </text>
            </g>
          ))}
        </svg>
        {hover !== null && (
          <div className="rc-chart-tip" style={{ left: `${(cx / W) * 100}%`, transform: "translateX(10px)" }}>
            <div className="rc-chart-tip-x">{segs[hover].label}</div>
            <div className="rc-chart-tip-row">
              <span className="rc-chart-chip" style={{ background: seriesColor(hover) }} />
              <span className="rc-chart-tip-val">
                {fmt(segs[hover].value)} · {share(segs[hover].frac)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function HBarChart({ title, x, series, yLabel, stacked }: ComponentProps<"chart">) {
  const [hover, setHover] = useState<number | null>(null);
  const isStacked = stacked === true && series.length > 1;
  const cols = isStacked ? stackSegments(series, x.length) : null;
  // Scale on what is DRAWN: every mark renderer clips values to x.length
  // (one value per x label), so extra values must not stretch the axis with
  // invisible data (2026-07-28 fix — stacked was already bounded via xLen).
  const values = cols
    ? cols.flatMap((col) => (col.length ? [col[col.length - 1].hi] : []))
    : series.flatMap((s) => s.values.slice(0, x.length)).filter(Number.isFinite);
  const tks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const vMin = tks[0];
  const vMax = tks[tks.length - 1] === vMin ? vMin + 1 : tks[tks.length - 1];

  // The left band is the point of horizontal: category labels render whole.
  const labelW = Math.min(
    240,
    Math.max(56, Math.max(...x.map((l) => l.length)) * 6.6 + 16),
  );
  const barH = 12;
  const band = isStacked || series.length === 1 ? 26 : series.length * (barH + 2) + 12;
  const groupH = series.length === 1 ? barH : series.length * (barH + 2) - 2;
  const rowTop = (i: number, si: number) =>
    PAD.top + i * band + (band - groupH) / 2 + si * (barH + 2);
  const hgt = PAD.top + x.length * band + 30;
  const iw = W - labelW - 20;
  const xPos = (v: number) => labelW + ((v - vMin) / (vMax - vMin)) * iw;
  const x0 = xPos(Math.max(vMin, Math.min(0, vMax)));

  return (
    <div className="rc rc-chart">
      {title && <div className="rc-title">{title}</div>}
      {series.length >= 2 && <Legend series={series} />}
      <div className="rc-chart-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${hgt}`} role="img" aria-label={title ?? "bar chart"}>
          {/* recessive vertical grid + value labels along the bottom */}
          {tks.map((t, i) => (
            <g key={i}>
              <line x1={xPos(t)} x2={xPos(t)} y1={PAD.top} y2={hgt - 26} style={GRID} strokeWidth="1" />
              <text x={xPos(t)} y={hgt - 10} textAnchor="middle" fontSize="10.5" style={INK_MUTED}>
                {fmt(t)}
              </text>
            </g>
          ))}
          {/* unit label top-right (mirror of vertical's top-left): the bottom
              row belongs to the tick labels — sharing it overlapped the last
              tick into e.g. "15"+"s" (caught on the screenshot pass) */}
          {yLabel && (
            <text x={W - 20} y={PAD.top - 5} textAnchor="end" fontSize="10" style={INK_MUTED}>
              {yLabel}
            </text>
          )}
          {/* category labels, whole — the reason this orientation exists */}
          {x.map((label, i) => (
            <text
              key={i}
              x={labelW - 8}
              y={PAD.top + i * band + band / 2 + 3.5}
              textAnchor="end"
              fontSize="10.5"
              style={INK_MUTED}
            >
              {elide(label, 34)}
            </text>
          ))}

          {isStacked && cols
            ? cols.map((col, i) =>
                col.map((seg, k) => {
                  const by = PAD.top + i * band + (band - barH) / 2;
                  const isEnd = k === col.length - 1;
                  const lo = xPos(seg.lo);
                  const hi = xPos(seg.hi);
                  return isEnd ? (
                    <path
                      key={`${i}-${k}`}
                      className="rc-chart-hbar"
                      d={hBarPath(by, hi, barH, lo)}
                      fill={seriesColor(seg.si)}
                      style={SURFACE}
                      strokeWidth="1"
                      opacity={dimUnlessHovered(hover, i)}
                    />
                  ) : (
                    <rect
                      key={`${i}-${k}`}
                      className="rc-chart-hbar"
                      x={lo}
                      y={by}
                      width={Math.max(0, hi - lo)}
                      height={barH}
                      fill={seriesColor(seg.si)}
                      style={SURFACE}
                      strokeWidth="1"
                      opacity={dimUnlessHovered(hover, i)}
                    />
                  );
                }),
              )
            : series.map((s, si) =>
                s.values.slice(0, x.length).map((v, i) => {
                  if (!Number.isFinite(v)) return null;
                  const top = rowTop(i, si);
                  return (
                    <path
                      key={`${si}-${i}`}
                      className="rc-chart-hbar"
                      d={
                        v >= 0
                          ? hBarPath(top, xPos(v), barH, x0)
                          : `M${xPos(v)},${top} H${x0} V${top + barH} H${xPos(v)} Z`
                      }
                      fill={seriesColor(si)}
                      opacity={dimUnlessHovered(hover, i)}
                    />
                  );
                }),
              )}

          {/* hover hit rows — bigger than the marks */}
          {x.map((_, i) => (
            <rect
              key={i}
              x={labelW}
              y={PAD.top + i * band}
              width={iw}
              height={band}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {hover !== null && (
          <div
            className="rc-chart-tip"
            style={{
              left: "40%",
              top: `${((PAD.top + hover * band + band / 2) / hgt) * 100}%`,
            }}
          >
            <TipRows x={x} series={series} yLabel={yLabel} hover={hover} />
          </div>
        )}
      </div>
    </div>
  );
}

function VChart({ title, kind, x, series, yLabel, stacked }: ComponentProps<"chart">) {
  const [hover, setHover] = useState<number | null>(null);

  // S.2: stacked columns — the y scale spans the column TOTALS, not any one
  // series. A single series has nothing to stack; the flag is a quiet no-op.
  const isStacked = kind === "bar" && stacked === true && series.length > 1;
  const cols = isStacked ? stackSegments(series, x.length) : null;
  // Same domain rule as HBarChart, including the empty-column [] (an empty
  // stack contributes nothing; the Math.min/max 0-anchors cover it — the [0]
  // this once carried was copy-paste drift). Scale on what is DRAWN: marks
  // clip values to x.length, so extras must not stretch the axis (2026-07-28).
  const values = cols
    ? cols.flatMap((col) => (col.length ? [col[col.length - 1].hi] : []))
    : series.flatMap((s) => s.values.slice(0, x.length)).filter(Number.isFinite);
  const dataMin = Math.min(0, ...values);
  const dataMax = Math.max(0, ...values);
  const tks = niceTicks(dataMin, dataMax);
  const yMin = tks[0];
  const yMax = tks[tks.length - 1] === yMin ? yMin + 1 : tks[tks.length - 1];

  const padRight = kind === "line" && series.length >= 2 ? PAD.right : 16;
  const iw = W - PAD.left - padRight;
  const ih = H - PAD.top - PAD.bottom;
  const yPos = (v: number) => PAD.top + ih - ((v - yMin) / (yMax - yMin)) * ih;
  const xPos = (i: number) =>
    kind === "line"
      ? PAD.left + (x.length === 1 ? iw / 2 : (i * iw) / (x.length - 1))
      : PAD.left + (i + 0.5) * (iw / x.length);

  const labelStride = Math.ceil(x.length / 8);

  // Direct end labels (line, ≤4 series): nudge apart so they never collide.
  const endLabels =
    kind === "line" && series.length >= 2 && series.length <= 4
      ? series
          .map((s, si) => {
            const last = [...s.values].reverse().findIndex(Number.isFinite);
            const li = last === -1 ? -1 : s.values.length - 1 - last;
            return { name: s.name, color: seriesColor(si), y: li >= 0 ? yPos(s.values[li]) : NaN, xi: li };
          })
          .filter((l) => Number.isFinite(l.y))
          .sort((a, b) => a.y - b.y)
          .map((l, i, arr) => ({ ...l, y: i === 0 ? l.y : Math.max(l.y, arr[i - 1].y + 14) }))
      : [];

  const band = iw / x.length;
  const groupW = band * 0.72;
  const barW = Math.max(2, (groupW - 2 * (series.length - 1)) / series.length);

  return (
    <div className="rc rc-chart">
      {title && <div className="rc-title">{title}</div>}
      {series.length >= 2 && <Legend series={series} />}
      <div className="rc-chart-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title ?? `${kind} chart`}>
          {/* recessive grid + y labels */}
          {tks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.left} x2={W - padRight} y1={yPos(t)} y2={yPos(t)} style={GRID} strokeWidth="1" />
              <text x={PAD.left - 8} y={yPos(t) + 3.5} textAnchor="end" fontSize="10.5" style={INK_MUTED}>
                {fmt(t)}
              </text>
            </g>
          ))}
          {yLabel && (
            <text x={PAD.left - 8} y={PAD.top - 5} textAnchor="end" fontSize="10" style={INK_MUTED}>
              {yLabel}
            </text>
          )}
          {/* x labels, thinned */}
          {x.map((label, i) =>
            i % labelStride === 0 || i === x.length - 1 ? (
              <text key={i} x={xPos(i)} y={H - 8} textAnchor="middle" fontSize="10.5" style={INK_MUTED}>
                {elide(label, 12)}
              </text>
            ) : null,
          )}

          {kind === "bar" &&
            !isStacked &&
            series.map((s, si) =>
              s.values.slice(0, x.length).map((v, i) =>
                Number.isFinite(v) ? (
                  <path
                    key={`${si}-${i}`}
                    d={barPath(
                      PAD.left + i * band + (band - groupW) / 2 + si * (barW + 2),
                      yPos(v),
                      barW,
                      yPos(Math.max(yMin, Math.min(0, yMax))),
                    )}
                    fill={seriesColor(si)}
                    opacity={dimUnlessHovered(hover, i)}
                  />
                ) : null,
              ),
            )}

          {/* stacked: segments share one column; the surface stroke is the
              2px gap between fills; only the column's data end is rounded */}
          {isStacked &&
            cols &&
            cols.map((col, i) => {
              const stackW = Math.min(24, band * 0.72);
              const bx = PAD.left + i * band + (band - stackW) / 2;
              return col.map((seg, k) =>
                k === col.length - 1 ? (
                  <path
                    key={`${i}-${k}`}
                    className="rc-chart-seg"
                    d={barPath(bx, yPos(seg.hi), stackW, yPos(seg.lo))}
                    fill={seriesColor(seg.si)}
                    style={SURFACE}
                    strokeWidth="1"
                    opacity={dimUnlessHovered(hover, i)}
                  />
                ) : (
                  <rect
                    key={`${i}-${k}`}
                    className="rc-chart-seg"
                    x={bx}
                    y={yPos(seg.hi)}
                    width={stackW}
                    height={Math.max(0, yPos(seg.lo) - yPos(seg.hi))}
                    fill={seriesColor(seg.si)}
                    style={SURFACE}
                    strokeWidth="1"
                    opacity={dimUnlessHovered(hover, i)}
                  />
                ),
              );
            })}

          {kind === "line" && (
            <>
              {hover !== null && (
                <line x1={xPos(hover)} x2={xPos(hover)} y1={PAD.top} y2={PAD.top + ih} style={GRID} strokeWidth="1" />
              )}
              {series.map((s, si) => (
                <polyline
                  key={si}
                  points={s.values
                    .slice(0, x.length)
                    .map((v, i) => (Number.isFinite(v) ? `${xPos(i)},${yPos(v)}` : ""))
                    .filter(Boolean)
                    .join(" ")}
                  fill="none"
                  stroke={seriesColor(si)}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
              {/* hover markers: ≥8px, ringed with the surface color */}
              {hover !== null &&
                series.map((s, si) =>
                  Number.isFinite(s.values[hover]) ? (
                    <circle
                      key={si}
                      cx={xPos(hover)}
                      cy={yPos(s.values[hover])}
                      r="4.5"
                      fill={seriesColor(si)}
                      style={SURFACE}
                      strokeWidth="2"
                    />
                  ) : null,
                )}
              {endLabels.map((l, i) => (
                <g key={i}>
                  <circle cx={xPos(l.xi) + 8} cy={l.y} r="3" fill={l.color} />
                  <text x={xPos(l.xi) + 15} y={l.y + 3.5} fontSize="10.5" style={INK}>
                    {elide(l.name, 14)}
                  </text>
                </g>
              ))}
            </>
          )}

          {/* hover hit columns — bigger than the marks */}
          {x.map((_, i) => (
            <rect
              key={i}
              x={PAD.left + i * band}
              y={PAD.top}
              width={band}
              height={ih}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {hover !== null && (
          <div
            className="rc-chart-tip"
            style={{
              left: `${(xPos(hover) / W) * 100}%`,
              transform: hover > x.length / 2 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
            }}
          >
            <TipRows x={x} series={series} yLabel={yLabel} hover={hover} />
          </div>
        )}
      </div>
    </div>
  );
}
