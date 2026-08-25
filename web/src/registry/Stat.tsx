import type { ComponentProps } from "@registry-spec";

// The KPI tile: one glanceable number, the natural pin-dock
// resident, kept live by update-in-place re-sends on the same wire id.

/** Arrow + tone for the delta — direction rides the glyph (never color
 *  alone), tone follows `good` (up isn't always good). Pure, for Tier-1. */
export function deltaMeta(delta: { direction: "up" | "down"; good: boolean }): {
  arrow: "↑" | "↓";
  tone: "good" | "bad";
} {
  return {
    arrow: delta.direction === "up" ? "↑" : "↓",
    tone: delta.good ? "good" : "bad",
  };
}

export function Stat({ label, value, delta, footer }: ComponentProps<"stat">) {
  const meta = delta && deltaMeta(delta);
  return (
    <div className="rc rc-stat">
      <div className="rc-stat-label">{label}</div>
      <div className="rc-stat-row">
        <span className="rc-stat-value">{value}</span>
        {delta && meta && (
          <span
            className={`rc-stat-delta rc-stat-delta-${meta.tone}`}
            title={meta.tone === "good" ? "improved" : "worse"}
          >
            <span aria-hidden="true">{meta.arrow}</span> {delta.value}
          </span>
        )}
      </div>
      {footer && <div className="rc-stat-footer">{footer}</div>}
    </div>
  );
}
