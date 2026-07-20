import { useEffect, type RefObject } from "react";

/**
 * Modal focus management (A.3) — the companion to `useEscapeKey`, and the
 * same idiom: pass `active: false` while the overlay is closed and the
 * listener doesn't exist.
 *
 * Three things, all of which an overlay needs and none of which the browser
 * does on its own: move focus INTO the overlay when it opens, keep Tab
 * cycling inside it while it's open, and return focus to whatever opened it
 * on close. Without the last one a keyboard user is dropped at the top of the
 * document every time they close a card.
 *
 * Escape stays `useEscapeKey`'s job — the two compose, and keeping them
 * separate means an overlay can take one without the other.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    // Whatever had focus when we opened — the button that opened us, almost
    // always. Restored on close.
    const opener = document.activeElement as HTMLElement | null;

    // Rendered-and-visible only. `getClientRects().length` rather than
    // `offsetParent`, which is null for position:fixed elements — these cards
    // are fixed, so the cheaper check would have found nothing at all.
    const focusable = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );

    (focusable()[0] ?? container).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const here = document.activeElement;
      const outside = !container.contains(here);
      if (e.shiftKey && (here === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (here === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };

    // Capture phase: the trap must win before anything inside the overlay
    // gets to act on Tab.
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, [ref, active]);
}
