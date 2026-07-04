import { useState } from "react";
import type { ComponentProps } from "@registry-spec";

// Categorical palette validated (dataviz six-checks) against the app's dark
// surface #141a26 — fixed slot order is the CVD-safety mechanism, never cycle
// or reorder it. Adjacent-pair CVD sits in the floor band, so ≥2-series
// charts always carry secondary encoding: legend + tooltip + end labels.
const COLORS = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767"];
const SURFACE = "#141a26";
const GRID = "#1d2434";
const INK_MUTED = "#8b96a8";
const INK = "#c7d0dd";

const W = 640;
const H = 260;
const PAD = { top: 16, right: 118, bottom: 28, left: 48 };

function niceTicks(min: number, max: number, count = 4): number[] {
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

const fmt = (v: number): string =>
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

export function Chart({ title, kind, x, series, yLabel }: ComponentProps<"chart">) {
  const [hover, setHover] = useState<number | null>(null);

  const values = series.flatMap((s) => s.values).filter(Number.isFinite);
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
            return { name: s.name, color: COLORS[si % COLORS.length], y: li >= 0 ? yPos(s.values[li]) : NaN, xi: li };
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
      {series.length >= 2 && (
        <div className="rc-chart-legend">
          {series.map((s, i) => (
            <span key={i} className="rc-chart-key">
              <span className="rc-chart-chip" style={{ background: COLORS[i % COLORS.length] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="rc-chart-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title ?? `${kind} chart`}>
          {/* recessive grid + y labels */}
          {tks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.left} x2={W - padRight} y1={yPos(t)} y2={yPos(t)} stroke={GRID} strokeWidth="1" />
              <text x={PAD.left - 8} y={yPos(t) + 3.5} textAnchor="end" fontSize="10.5" fill={INK_MUTED}>
                {fmt(t)}
              </text>
            </g>
          ))}
          {yLabel && (
            <text x={PAD.left - 8} y={PAD.top - 5} textAnchor="end" fontSize="10" fill={INK_MUTED}>
              {yLabel}
            </text>
          )}
          {/* x labels, thinned */}
          {x.map((label, i) =>
            i % labelStride === 0 || i === x.length - 1 ? (
              <text key={i} x={xPos(i)} y={H - 8} textAnchor="middle" fontSize="10.5" fill={INK_MUTED}>
                {label.length > 12 ? label.slice(0, 11) + "…" : label}
              </text>
            ) : null,
          )}

          {kind === "bar" &&
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
                    fill={COLORS[si % COLORS.length]}
                    opacity={hover === null || hover === i ? 1 : 0.45}
                  />
                ) : null,
              ),
            )}

          {kind === "line" && (
            <>
              {hover !== null && (
                <line x1={xPos(hover)} x2={xPos(hover)} y1={PAD.top} y2={PAD.top + ih} stroke="#313b4e" strokeWidth="1" />
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
                  stroke={COLORS[si % COLORS.length]}
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
                      fill={COLORS[si % COLORS.length]}
                      stroke={SURFACE}
                      strokeWidth="2"
                    />
                  ) : null,
                )}
              {endLabels.map((l, i) => (
                <g key={i}>
                  <circle cx={xPos(l.xi) + 8} cy={l.y} r="3" fill={l.color} />
                  <text x={xPos(l.xi) + 15} y={l.y + 3.5} fontSize="10.5" fill={INK}>
                    {l.name.length > 14 ? l.name.slice(0, 13) + "…" : l.name}
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
            <div className="rc-chart-tip-x">{x[hover]}</div>
            {series.map((s, si) =>
              Number.isFinite(s.values[hover]) ? (
                <div key={si} className="rc-chart-tip-row">
                  <span className="rc-chart-chip" style={{ background: COLORS[si % COLORS.length] }} />
                  <span className="rc-chart-tip-name">{s.name}</span>
                  <span className="rc-chart-tip-val">
                    {fmt(s.values[hover])}
                    {yLabel ? ` ${yLabel}` : ""}
                  </span>
                </div>
              ) : null,
            )}
          </div>
        )}
      </div>
    </div>
  );
}
