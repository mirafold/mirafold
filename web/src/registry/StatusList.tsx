import type { ComponentProps } from "@registry-spec";
import { Md, MdDetail } from "./Md";

// Check results as rows with a verdict pill (test suites, CI checks, lint,
// health probes) — the pill carries a glyph + the status word, so state never
// rides on color alone.

type Status = ComponentProps<"status-list">["items"][number]["status"];

/** Glyph per status — exported so the Tier-1 test can pin that every schema
 *  status has one (enum drift fails loudly, not as an undefined lookup). */
export const STATUS_GLYPH: Record<Status, string> = {
  pass: "✓",
  fail: "✕",
  warn: "!",
  pending: "◐",
  skip: "–",
};

export function StatusList({ title, items }: ComponentProps<"status-list">) {
  return (
    <div className="rc rc-statuslist">
      {title && <div className="rc-statuslist-title">{title}</div>}
      <ul className="rc-statuslist-rows">
        {items.map((item, i) => (
          <li key={i} className="rc-status-row">
            <span className={`rc-status-pill rc-status-${item.status}`}>
              <span aria-hidden="true">{STATUS_GLYPH[item.status]}</span> {item.status}
            </span>
            <div className="rc-status-text">
              <Md text={item.label} inline />
              {item.detail && <MdDetail text={item.detail} />}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
