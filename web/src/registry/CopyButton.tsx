import { useState } from "react";

/** The registry's copy-to-clipboard affordance: "copy" flips to "copied" for
 *  a beat. Copies `text` verbatim — for clipped bodies (console) that's the
 *  WHOLE payload, which is the point. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="rc-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
