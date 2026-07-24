import { useEffect, useState } from "react";

// Live phone-width detection (E.4). PromptBox's IS_PHONE is a module-load
// constant — fine for a one-shot layout choice, wrong for a component that
// must re-render when the viewport crosses the breakpoint (a rotate, a
// desktop window resize, and every e2e that drives one page across widths).
// This tracks the media query for the component's lifetime.
const PHONE_QUERY = "(max-width: 640px)";

export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_QUERY)?.matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(PHONE_QUERY);
    if (!mq) return;
    const onChange = () => setPhone(mq.matches);
    onChange(); // sync in case it changed between first render and effect
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return phone;
}
