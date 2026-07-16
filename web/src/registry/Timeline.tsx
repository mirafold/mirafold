import type { ComponentProps } from "@registry-spec";
import { Md } from "./Md";

export function Timeline({ title, items }: ComponentProps<"timeline">) {
  return (
    <div className="rc rc-timeline">
      {title && <div className="rc-title">{title}</div>}
      <ol>
        {items.map((item, i) => (
          <li key={i}>
            <span className="rc-timeline-dot" aria-hidden />
            <div className="rc-timeline-body">
              <div className="rc-timeline-head">
                <Md text={item.label} inline />
                {item.time && <span className="rc-timeline-time">{item.time}</span>}
              </div>
              {item.detail && (
                <div className="rc-detail">
                  <Md text={item.detail} inline />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
