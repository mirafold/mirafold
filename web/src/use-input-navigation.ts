import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type RefObject,
} from "react";
import {
  adjacentInputIndex,
  inputIndexAtViewport,
  isNavigableInputRow,
  type InputNavigationDirection,
} from "./input-navigation";

export type InputNavigationState = {
  /** One-based position while an input is selected; null outside navigation. */
  position: number | null;
  total: number;
};

export type InputNavigationHandle = {
  /** Select the input governing the output-zone viewport without moving it. */
  openAtViewport: () => boolean;
  /** Select and reveal the newest submitted input. */
  openLatest: () => boolean;
  /** Move from the selected input without wrapping. */
  move: (direction: InputNavigationDirection, focusDestination?: boolean) => boolean;
  close: () => void;
};

export type InputNavigationTarget = {
  index: number;
  total: number;
  selected: boolean;
  setElement: (element: HTMLDivElement | null) => void;
  onMove: (index: number, direction: InputNavigationDirection) => void;
  onReturnToTail: () => void;
  onExit: () => void;
};

type InputRow = { id: number; kind: string; role?: string };

type NavigationTail = {
  scrollerRef: RefObject<HTMLDivElement | null>;
  scrollToDetached: (top: number) => void;
  armFollow: () => void;
  isAtBottom: () => boolean;
};

type InputNavigationOptions = {
  rows: readonly InputRow[];
  tail: NavigationTail;
  focusPrompt: () => void;
  onChange?: (state: InputNavigationState) => void;
  ref: ForwardedRef<InputNavigationHandle>;
};

/** Own the selection, DOM destinations, and scroll behavior for input history. */
export function useInputNavigation({
  rows,
  tail,
  focusPrompt,
  onChange,
  ref,
}: InputNavigationOptions): (id: number) => InputNavigationTarget | undefined {
  // Selection identity and activation identity are different: clicking the
  // same direct arrow twice still needs to repeat its scroll/focus work. A
  // fresh object makes every activation observable while `id` remains the
  // stable row identity used everywhere else.
  const [selection, setSelection] = useState<{ id: number } | null>(null);
  const selectedInputId = selection?.id ?? null;
  const inputElements = useRef(new Map<number, HTMLDivElement>());
  // Desktop navigation transfers keyboard focus into the selected strip;
  // phone navigation deliberately does not. Keep that ownership separate
  // from selection so a replay can recover focus without opening a phone's
  // software keyboard.
  const keyboardDestinationId = useRef<number | null>(null);
  const selectionOwner = useRef<"desktop" | "phone" | null>(null);
  const pendingDestination = useRef<{
    id: number;
    scroll: boolean;
    focus: boolean;
  } | null>(null);
  const inputRows = useMemo(() => rows.filter(isNavigableInputRow), [rows]);
  const inputIndexById = useMemo(
    () => new Map(inputRows.map((row, index) => [row.id, index])),
    [inputRows],
  );
  const selectedInputIndex =
    selectedInputId === null ? -1 : (inputIndexById.get(selectedInputId) ?? -1);

  useLayoutEffect(() => {
    if (selectedInputId !== null && selectedInputIndex < 0) {
      const activeElement = document.activeElement;
      const activeElementWasLost = !activeElement || activeElement === document.body;
      const shouldRestorePrompt =
        selectionOwner.current === "desktop" &&
        keyboardDestinationId.current === selectedInputId &&
        activeElementWasLost;
      const shouldRestoreTranscript =
        selectionOwner.current === "phone" &&
        (activeElementWasLost ||
          (activeElement instanceof HTMLElement &&
            activeElement.closest("[data-input-navigation-phone]") !== null));
      pendingDestination.current = null;
      keyboardDestinationId.current = null;
      selectionOwner.current = null;
      if (shouldRestorePrompt) focusPrompt();
      else {
        // A phone action can disappear when replay replaces its selected row.
        // Move its focus to the stable transcript before the card unmounts so
        // PromptBox's generic body-focus recovery cannot summon the keyboard.
        if (shouldRestoreTranscript) {
          tail.scrollerRef.current?.focus({ preventScroll: true });
        }
        setSelection(null);
      }
    }
  }, [focusPrompt, selectedInputId, selectedInputIndex, tail.scrollerRef]);

  useEffect(() => {
    onChange?.({
      position: selectedInputIndex < 0 ? null : selectedInputIndex + 1,
      total: inputRows.length,
    });
  }, [inputRows.length, onChange, selectedInputIndex]);

  useLayoutEffect(() => {
    const destination = pendingDestination.current;
    if (!destination || destination.id !== selectedInputId) return;
    pendingDestination.current = null;
    const scroller = tail.scrollerRef.current;
    const element = inputElements.current.get(destination.id);
    if (!scroller || !element) return;
    if (destination.scroll) {
      const scrollerRect = scroller.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      // Input navigation is an explicit decision to leave the live tail. The
      // tail owns this assignment so its resulting scroll event cannot re-arm
      // following merely because the browser clamps the jump at the bottom.
      tail.scrollToDetached(
        scroller.scrollTop + elementRect.top - scrollerRect.top - 8,
      );
    }
    if (destination.focus) {
      element.focus({ preventScroll: true });
      if (document.activeElement !== element) keyboardDestinationId.current = null;
    }
  }, [selectedInputId, selection, tail]);

  const activateInput = useCallback(
    (
      index: number,
      scroll: boolean,
      focus: boolean,
      owner: "desktop" | "phone",
    ): boolean => {
      const input = inputRows[index];
      if (!input) return false;
      pendingDestination.current = { id: input.id, scroll, focus };
      keyboardDestinationId.current = owner === "desktop" && focus ? input.id : null;
      selectionOwner.current = owner;
      setSelection({ id: input.id });
      return true;
    },
    [inputRows],
  );

  const inputIndexAtReadingEdge = useCallback((): number | null => {
    const scroller = tail.scrollerRef.current;
    if (!scroller) return null;
    const readingEdge = scroller.getBoundingClientRect().top + 1;
    const tops = inputRows.map(
      (row) => inputElements.current.get(row.id)?.getBoundingClientRect().top ?? Infinity,
    );
    return inputIndexAtViewport(tops, readingEdge);
  }, [inputRows, tail.scrollerRef]);

  const openAtViewport = useCallback((): boolean => {
    if (!tail.scrollerRef.current || inputRows.length === 0) return false;
    // When the reader is at the live tail (including a transcript shorter than
    // its viewport), the newest input is the unambiguous current one. Away
    // from the tail, response space belongs to the newest input above it.
    if (tail.isAtBottom()) {
      return activateInput(inputRows.length - 1, false, false, "phone");
    }
    const index = inputIndexAtReadingEdge();
    return index === null ? false : activateInput(index, false, false, "phone");
  }, [activateInput, inputIndexAtReadingEdge, inputRows.length, tail]);

  const openLatest = useCallback(
    (): boolean => activateInput(inputRows.length - 1, true, true, "desktop"),
    [activateInput, inputRows.length],
  );

  const move = useCallback(
    (direction: InputNavigationDirection, focusDestination = true): boolean => {
      const current =
        selectedInputIndex >= 0 ? selectedInputIndex : inputIndexAtReadingEdge();
      if (current === null) return false;
      const target = adjacentInputIndex(current, inputRows.length, direction);
      const owner =
        selectionOwner.current ?? (focusDestination ? "desktop" : "phone");
      return target === null
        ? false
        : activateInput(target, true, focusDestination, owner);
    },
    [activateInput, inputIndexAtReadingEdge, inputRows.length, selectedInputIndex],
  );

  const close = useCallback(() => {
    pendingDestination.current = null;
    keyboardDestinationId.current = null;
    selectionOwner.current = null;
    setSelection(null);
  }, []);

  useImperativeHandle(
    ref,
    () => ({ openAtViewport, openLatest, move, close }),
    [close, move, openAtViewport, openLatest],
  );

  const moveFromInput = useCallback(
    (index: number, direction: InputNavigationDirection) => {
      const target = adjacentInputIndex(index, inputRows.length, direction);
      if (target !== null) {
        activateInput(target, true, true, selectionOwner.current ?? "desktop");
      }
    },
    [activateInput, inputRows.length],
  );

  const returnToTail = useCallback(() => tail.armFollow(), [tail]);

  const exit = useCallback(() => {
    close();
    focusPrompt();
  }, [close, focusPrompt]);

  const navigationForInput = useCallback(
    (id: number): InputNavigationTarget | undefined => {
      const index = inputIndexById.get(id);
      if (index === undefined) return undefined;
      return {
        index,
        total: inputRows.length,
        selected: id === selectedInputId,
        setElement: (element) => {
          if (element) inputElements.current.set(id, element);
          else inputElements.current.delete(id);
        },
        onMove: moveFromInput,
        onReturnToTail: returnToTail,
        onExit: exit,
      };
    },
    [exit, inputIndexById, inputRows.length, moveFromInput, returnToTail, selectedInputId],
  );

  return navigationForInput;
}
