import type { ComponentProps } from "@registry-spec";
import { Md, MdDetail } from "./Md";

export function List({ title, ordered, items }: ComponentProps<"list">) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <div className="rc rc-list">
      {title && <div className="rc-title">{title}</div>}
      <Tag>
        {items.map((item, i) => (
          <li key={i}>
            <Md text={item.text} inline />
            {item.detail && <MdDetail text={item.detail} />}
          </li>
        ))}
      </Tag>
    </div>
  );
}
