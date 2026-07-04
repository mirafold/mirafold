import type { ComponentProps } from "@registry-spec";
import { Md } from "./Md";

export function Card({ title, body, footer }: ComponentProps<"card">) {
  return (
    <div className="rc rc-card">
      <div className="rc-card-title">{title}</div>
      <div className="rc-card-body">
        <Md text={body} />
      </div>
      {footer && <div className="rc-card-footer">{footer}</div>}
    </div>
  );
}
