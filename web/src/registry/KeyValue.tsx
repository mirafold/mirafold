import type { ComponentProps } from "@registry-spec";
import { Md } from "./Md";

export function KeyValue({ title, pairs }: ComponentProps<"key-value">) {
  return (
    <div className="rc rc-kv">
      {title && <div className="rc-title">{title}</div>}
      <dl>
        {pairs.map((p, i) => (
          <div className="rc-kv-row" key={i}>
            <dt>{p.key}</dt>
            <dd>
              <Md text={p.value} inline />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
