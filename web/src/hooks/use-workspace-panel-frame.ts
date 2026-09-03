import type { RefObject } from "react";
import { useEscapeKey } from "./use-escape";
import { useFocusTrap } from "./use-focus-trap";

/**
 * The one contract both auxiliary workspace surfaces (Files, Changes) frame
 * themselves with: on a phone an OPEN surface is a full-screen modal dialog —
 * focus-trapped, owning Escape exclusively (a drill-back or close must not
 * also reach the shell's busy interrupt); on desktop it is a docked column
 * beside a usable transcript — no trap, Escape left to the shell. Returns the
 * ARIA/tabindex attributes for the panel's root element.
 */
export function useWorkspacePanelFrame({
  panelRef,
  phone,
  open,
  onEscape,
  trapExtra,
  modal = true,
}: {
  panelRef: RefObject<HTMLElement | null>;
  phone: boolean;
  open: boolean;
  /** What Escape does while the surface owns it on phone. */
  onEscape: () => void;
  /** A second region the focus trap keeps reachable (a review draft prompt). */
  trapExtra?: RefObject<HTMLElement | null>;
  /** False while another dialog layer within the surface owns modality. */
  modal?: boolean;
}) {
  const trapped = phone && open;
  useFocusTrap(panelRef, trapped, trapExtra);
  useEscapeKey(trapped ? onEscape : undefined, { exclusive: true });
  return {
    role: phone ? ("dialog" as const) : undefined,
    "aria-modal": phone && modal ? true : undefined,
    tabIndex: phone ? -1 : undefined,
  };
}
