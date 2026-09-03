import { useEffect, useRef, useState } from "react";
import { copyText } from "../clipboard";

export type CopyState = "idle" | "copied" | "failed";

/** Copy-button state for any shell surface: "copied" or "failed" for a beat,
 *  then back to idle — never a silent click. One timer, cleared on the next
 *  click and on unmount. */
export function useCopyFeedback(): { state: CopyState; copy: (text: string) => void } {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = (text: string) => {
    void copyText(text).then((wrote) => {
      setState(wrote ? "copied" : "failed");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), 1500);
    });
  };
  return { state, copy };
}
