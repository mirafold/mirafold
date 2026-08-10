import { useEffect } from "react";

/**
 * Window-level "Escape dismisses/stops this" — the one idiom behind every
 * overlay (settings, connect-device, onboarding) and the busy interrupt.
 * Pass `undefined` while inactive; the listener exists only while a handler
 * is supplied.
 *
 * `exclusive` makes the handler OWN the keypress: capture phase plus
 * stopPropagation, so no other Escape listener fires — PickerBlock's idiom.
 * Every overlay wants this: without it, dismissing a card during a busy turn
 * also reached Shell's bubble-phase interrupt and silently halted the turn
 * (2026-07-28 review). The busy interrupt itself stays non-exclusive — it is
 * the fallback that runs only when nothing above it claimed the key.
 */
export function useEscapeKey(
  onEscape: (() => void) | undefined,
  { exclusive = false }: { exclusive?: boolean } = {},
) {
  useEffect(() => {
    if (!onEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (exclusive) e.stopPropagation();
      onEscape();
    };
    window.addEventListener("keydown", onKey, { capture: exclusive });
    return () => window.removeEventListener("keydown", onKey, { capture: exclusive });
  }, [onEscape, exclusive]);
}
