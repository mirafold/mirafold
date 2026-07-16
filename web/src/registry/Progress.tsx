import type { ComponentProps } from "@registry-spec";
import { MdDetail } from "./Md";

export function Progress({ label, percent, detail }: ComponentProps<"progress">) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <div className="rc rc-progress">
      <div className="rc-progress-head">
        <span className="rc-progress-label">{label}</span>
        <span className="rc-progress-pct">{Math.round(pct)}%</span>
      </div>
      <div className="rc-progress-track">
        <div className="rc-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {detail && <MdDetail text={detail} />}
    </div>
  );
}
