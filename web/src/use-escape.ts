import { useEffect } from "react";

/**
 * Window-level "Escape dismisses/stops this" — the one idiom behind every
 * overlay (settings, connect-device, onboarding) and the busy interrupt.
 * Pass `undefined` while inactive; the listener exists only while a handler
 * is supplied.
 */
export function useEscapeKey(onEscape: (() => void) | undefined) {
  useEffect(() => {
    if (!onEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape]);
}
