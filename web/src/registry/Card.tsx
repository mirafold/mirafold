import type { ComponentProps } from "@registry-spec";
import { Md } from "./Md";
import { ActionRow } from "./actions";

export function Card({ title, body, footer, kind, actions }: ComponentProps<"card">) {
  return (
    <div className={`rc rc-card${kind ? ` rc-card-${kind}` : ""}`}>
      <div className="rc-card-title">{title}</div>
      <div className="rc-card-body">
        <Md text={body} />
      </div>
      {footer && <div className="rc-card-footer">{footer}</div>}
      <ActionRow actions={actions} />
    </div>
  );
}
