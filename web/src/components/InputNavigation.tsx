import { useEffect, useRef, type PropsWithChildren } from "react";
import type { InputNavigationDirection } from "../input/input-navigation";
import type { InputNavigationTarget } from "../input/use-input-navigation";

export type PhoneInputNavigationModel = {
  available: boolean;
  open: boolean;
  position: number | null;
  total: number;
  onOpen: () => void;
  onClose: () => void;
  onMove: (direction: InputNavigationDirection) => void;
};

export function InputNavigationStop({
  className,
  navigation,
  children,
}: PropsWithChildren<{
  className: string;
  navigation?: InputNavigationTarget;
}>) {
  return (
    <div
      className={
        `${className} input-nav-stop` +
        (navigation?.selected ? " is-input-nav-current" : "")
      }
      ref={navigation?.setElement}
      tabIndex={navigation?.selected ? 0 : undefined}
      aria-current={navigation?.selected ? "true" : undefined}
      onKeyDown={
        navigation ? (event) => handleInputNavigationKey(event, navigation) : undefined
      }
    >
      {children}
      {navigation && <InputNavigationButtons navigation={navigation} />}
    </div>
  );
}

function handleInputNavigationKey(
  event: React.KeyboardEvent<HTMLDivElement>,
  navigation: InputNavigationTarget,
) {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  if (event.key === "End") {
    // End is the transcript's existing keyboard return-to-tail gesture. It
    // must re-arm even when navigation already landed at the current bottom
    // and the browser therefore has no physical scroll event to report.
    navigation.onReturnToTail();
    return;
  }
  // Only the selected strip owns navigation keys. Buttons on every other
  // strip remain ordinary controls, so their bubbling Escape can still reach
  // the shell's page-wide busy interrupt.
  if (!navigation.selected) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    navigation.onExit();
    return;
  }
  const direction =
    event.key === "ArrowUp" ? "older" : event.key === "ArrowDown" ? "newer" : null;
  if (!direction) return;
  event.preventDefault();
  event.stopPropagation();
  navigation.onMove(navigation.index, direction);
}

function InputNavigationButtons({ navigation }: { navigation: InputNavigationTarget }) {
  const hasOlder = navigation.index > 0;
  const hasNewer = navigation.index + 1 < navigation.total;
  return (
    <span
      className="input-nav-inline"
      role="group"
      aria-label={`Navigate from input ${navigation.index + 1} of ${navigation.total}`}
      data-input-navigation-control
      data-transcript-control
    >
      <button
        type="button"
        className="input-nav-arrow input-nav-older"
        disabled={!hasOlder}
        title={hasOlder ? "Older input" : "No older input"}
        aria-label={
          hasOlder
            ? `Go to older input ${navigation.index} of ${navigation.total}`
            : "No older input"
        }
        onClick={() => navigation.onMove(navigation.index, "older")}
      >
        ↑
      </button>
      <button
        type="button"
        className="input-nav-arrow input-nav-newer"
        disabled={!hasNewer}
        title={hasNewer ? "Newer input" : "No newer input"}
        aria-label={
          hasNewer
            ? `Go to newer input ${navigation.index + 2} of ${navigation.total}`
            : "No newer input"
        }
        onClick={() => navigation.onMove(navigation.index, "newer")}
      >
        ↓
      </button>
    </span>
  );
}

export function PhoneInputNavigation({
  navigation,
  completionOpen,
}: {
  navigation: PhoneInputNavigationModel;
  completionOpen: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const visible = navigation.available && navigation.total >= 2 && !completionOpen;

  useEffect(() => {
    if (!navigation.open) return;
    if (!visible) {
      navigation.onClose();
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !containerRef.current?.contains(target)) {
        navigation.onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.shiftKey ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      ) return;
      event.preventDefault();
      event.stopPropagation();
      // The focused card action is about to unmount. Restore its disclosure
      // trigger first; pointer/lifecycle closes deliberately do not move focus.
      toggleRef.current?.focus({ preventScroll: true });
      navigation.onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [navigation.onClose, navigation.open, visible]);

  if (!visible) return null;

  const toggleLabel = navigation.open
    ? "Close input navigation"
    : "Navigate submitted inputs";

  return (
    <div
      className="input-nav-phone"
      data-input-navigation-control
      data-input-navigation-phone
      ref={containerRef}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        // Keyboard focus moving to another shell control ends this temporary
        // disclosure before that control can open a modal or workspace. A
        // null destination is different: touch activation at a newly disabled
        // endpoint can leave BODY focused and must keep repeated navigation
        // available.
        const keepsNavigation =
          nextTarget instanceof Element && nextTarget.closest(".is-input-nav-current");
        if (
          nextTarget instanceof Node &&
          !event.currentTarget.contains(nextTarget) &&
          !keepsNavigation
        ) {
          navigation.onClose();
        }
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        className="input-nav-phone-toggle"
        onClick={navigation.open ? navigation.onClose : navigation.onOpen}
        aria-label={toggleLabel}
        aria-expanded={navigation.open}
        title={toggleLabel}
      >
        ⋯
      </button>
      {navigation.open && navigation.position !== null && (
        <div
          className="input-nav-phone-card"
          role="group"
          aria-label={`Navigate submitted inputs, input ${navigation.position} of ${navigation.total}`}
        >
          <div className="input-nav-phone-count">
            input {navigation.position} of {navigation.total}
          </div>
          <div className="input-nav-phone-actions">
            <button
              type="button"
              disabled={navigation.position <= 1}
              onClick={() => navigation.onMove("older")}
              aria-label="Go to older input"
            >
              <span aria-hidden="true">↑</span> older
            </button>
            <button
              type="button"
              disabled={navigation.position >= navigation.total}
              onClick={() => navigation.onMove("newer")}
              aria-label="Go to newer input"
            >
              newer <span aria-hidden="true">↓</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
