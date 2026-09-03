import { useCopyFeedback } from "../hooks/use-copy-feedback";

const LABEL = { idle: "copy", copied: "copied", failed: "copy failed" } as const;

/** The registry's copy-to-clipboard affordance. Copies `text` verbatim — for
 *  clipped bodies (console) that's the WHOLE payload, which is the point. */
export function CopyButton({ text }: { text: string }) {
  const { state, copy } = useCopyFeedback();
  return (
    <button className={state === "failed" ? "rc-copy rc-copy-failed" : "rc-copy"} onClick={() => copy(text)}>
      {LABEL[state]}
    </button>
  );
}
