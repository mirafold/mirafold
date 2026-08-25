import { useEffect, useState } from "react";

// Live phone-width detection: tracks the media query for the component's
// lifetime, so a rotate, a desktop window resize, and an e2e that drives one
// page across widths all re-render across the breakpoint.
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
