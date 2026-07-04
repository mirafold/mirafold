import type { ComponentProps } from "@registry-spec";
import { Md } from "./Md";

export function List({ title, ordered, items }: ComponentProps<"list">) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <div className="rc rc-list">
      {title && <div className="rc-title">{title}</div>}
      <Tag>
        {items.map((item, i) => (
          <li key={i}>
            <Md text={item.text} inline />
            {item.detail && (
              <div className="rc-detail">
                <Md text={item.detail} inline />
              </div>
            )}
          </li>
        ))}
      </Tag>
    </div>
  );
}
