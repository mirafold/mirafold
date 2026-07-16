import { useState } from "react";
import type { ComponentProps } from "@registry-spec";
import { Md } from "./Md";
import { useAction } from "./actions";

// A structured fork: clicking an option sends it as the user's next turn via
// the same shell-mediated action path as card buttons. `chosen` is local mount
// state — it locks this copy after one click; the server's action rate limit
// still backstops a re-mounted copy (pin, re-attach).
export function Question({ question, options }: ComponentProps<"question">) {
  const emit = useAction();
  const [chosen, setChosen] = useState<number | null>(null);
  return (
    <div className="rc rc-question">
      <div className="rc-question-q">
        <Md text={question} inline />
      </div>
      <div className="rc-question-opts">
        {options.map((o, i) => (
          <button
            key={i}
            className={`rc-question-opt${chosen === i ? " rc-question-chosen" : ""}`}
            disabled={chosen !== null}
            onClick={() => {
              setChosen(i);
              emit({ kind: "prompt", text: o.text ?? o.label });
            }}
          >
            <span className="rc-question-label">{o.label}</span>
            {o.detail && (
              <span className="rc-question-detail">
                <Md text={o.detail} inline />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
