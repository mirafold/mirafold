import { useRef, type ReactNode } from "react";
import { useEscapeKey } from "../hooks/use-escape";
import { useFocusTrap } from "../hooks/use-focus-trap";

/**
 * The one modal idiom every card shares (pairing, settings, agent picker): a
 * backdrop that dismisses, a focus-trapped dialog with the ARIA a screen
 * reader needs, and Escape doing what the backdrop does. Mount it only while
 * the card is open — the trap activates on mount and hands focus back to the
 * opener on unmount.
 *
 * The backdrop stays a plain div on purpose: its click-to-dismiss is a
 * MOUSE convenience whose keyboard equivalent — Escape — already exists, so
 * making it a control would only park a page-sized, meaningless stop in the
 * tab order.
 */
export function ModalCard({
  overlayClass,
  cardClass,
  titleId,
  onDismiss,
  children,
}: {
  overlayClass: string;
  cardClass: string;
  /** id of the element inside that names the dialog (aria-labelledby). */
  titleId: string;
  /** Backdrop click and Escape; undefined = the card can't be dismissed. */
  onDismiss?: () => void;
  children: ReactNode;
}) {
  // Exclusive: dismissing the card is the WHOLE keypress — it must not also
  // reach Shell's busy-interrupt listener and halt the running turn.
  useEscapeKey(onDismiss, { exclusive: true });
  const card = useRef<HTMLDivElement>(null);
  useFocusTrap(card, true);

  return (
    <div className={overlayClass} onClick={onDismiss}>
      <div
        className={cardClass}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={card}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
