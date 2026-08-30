import { useRef, useState } from "react";

/**
 * Follow-the-tail for a scrolling transcript, CONDITIONAL the way a terminal's
 * scrollback is: new output scrolls the reader down only while they're already
 * at the bottom. Scroll up and the view freezes where they put it — output
 * keeps landing below, out of sight — until they come back down.
 *
 * Wire up all five parts: `scrollerRef` on the scrolling element, and
 * `onScroll` / `onWheel` / `onTouchStart` / `onTouchMove` as its handlers.
 * Then call `followTail()` from an effect keyed on whatever changes the
 * content, `armFollow()` when the reader is conceptually back at the bottom
 * (they sent a message), and `resetTail()` when the content is replaced
 * wholesale. `detached` is the same fact as render state — true while the
 * reader is up in scrollback — so the shell can offer a way back
 * (`jumpToTail()`); the ref stays the source of truth for the handlers,
 * which run between renders.
 *
 * Two decisions here, each guarding a real browser failure — don't undo
 * either:
 *
 *  1. **Following scrolls INSTANTLY, never smoothly.** A smooth scroll is an
 *     animation, and during streaming `followTail` fires every ~35ms, so the
 *     animation would be permanently in flight. While it runs it owns
 *     `scrollTop`: the reader's wheel deltas are overwritten by the next
 *     animation frame and never become scroll events at all — the wheel is
 *     inert. It also can never catch a tail growing faster than it animates,
 *     leaving a "following" reader ~5000px behind the live output.
 *  2. **The reader's INPUT is what detaches, not a position delta.** A wheel
 *     or touch drag says "the reader is steering" whether or not the viewport
 *     ends up moving, so it can't be suppressed the way a delta can. The
 *     position test stays as a backstop for the scrolls that have no input
 *     event of their own — a scrollbar drag, find-in-page, a keyboard scroll
 *     — and is trustworthy because our own scrolls are single downward jumps
 *     rather than an easing curve.
 */

// Enough that a trackpad stopping just short of the end still counts as the
// end (about one line of transcript text), and more than the fraction of a
// pixel that subpixel scroll heights leave behind. A judgment call, not a
// measurement.
const BOTTOM_SLACK_PX = 24;
const WHEEL_LINE_PX = 16;

type ScrollGeometry = Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">;
type WheelIntent = { deltaY: number; deltaMode?: number };
type TouchIntent = { touches: ArrayLike<{ clientY: number }> };

const bottomGap = (el: ScrollGeometry) => el.scrollHeight - el.scrollTop - el.clientHeight;
const firstTouchY = (event: TouchIntent) => event.touches[0]?.clientY;

const intentReachesBottom = (el: ScrollGeometry, deltaPx: number) =>
  deltaPx > 0 && bottomGap(el) <= deltaPx + BOTTOM_SLACK_PX;

function wheelDeltaPixels(el: ScrollGeometry, e: WheelIntent): number {
  if (e.deltaMode === 1) return e.deltaY * WHEEL_LINE_PX;
  if (e.deltaMode === 2) return e.deltaY * el.clientHeight;
  return e.deltaY;
}

/**
 * Decide from the geometry that existed when the user steered, before the
 * browser dispatches a later scroll event and before streamed output can move
 * the bottom. Exported so the race's exact boundary is pinned without a DOM
 * test harness.
 */
export function wheelIntentReachesBottom(el: ScrollGeometry, e: WheelIntent): boolean {
  return intentReachesBottom(el, wheelDeltaPixels(el, e));
}

/** Finger moving up scrolls the transcript toward its tail. */
export function touchIntentReachesBottom(
  el: ScrollGeometry,
  previousY: number,
  nextY: number,
): boolean {
  return intentReachesBottom(el, previousY - nextY);
}

export function useFollowTail() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [detached, setDetached] = useState(false);
  const setFollowing = (next: boolean) => {
    following.current = next;
    setDetached(!next);
  };
  const lastTop = useRef(0);
  // A navigation-owned scroll can legitimately land at the current bottom.
  // Remember its settled position so that scroll event cannot masquerade as
  // the reader returning to the tail. Any later movement clears the hold.
  const navigationTop = useRef<number | null>(null);
  const touchY = useRef<number | null>(null);

  const atBottom = (el: HTMLElement) => bottomGap(el) <= BOTTOM_SLACK_PX;

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    if (navigationTop.current !== null) {
      if (Math.abs(el.scrollTop - navigationTop.current) <= 1) {
        lastTop.current = el.scrollTop;
        return;
      }
      navigationTop.current = null;
    }
    // The backstop: an upward move we got no input event for.
    if (el.scrollTop < lastTop.current - 1) setFollowing(false);
    if (atBottom(el)) setFollowing(true);
    lastTop.current = el.scrollTop;
  };

  // Steering UP detaches. A gesture that will reach the current bottom arms
  // synchronously: waiting for onScroll is racy because streamed paint can
  // move the bottom by more than the slack before that event runs.
  const onWheel = (e: WheelIntent) => {
    navigationTop.current = null;
    if (e.deltaY < 0) {
      setFollowing(false);
      return;
    }
    const el = scrollerRef.current;
    if (el && wheelIntentReachesBottom(el, e)) setFollowing(true);
  };

  const onTouchStart = (e: TouchIntent) => {
    touchY.current = firstTouchY(e) ?? null;
  };

  // Dragging the content DOWN scrolls the transcript up — the touch equivalent
  // of a negative wheel delta.
  //
  // Fires and detaches on a real emulated-touch swipe, but NOT proven
  // necessary: touch holds correctly without these handlers, because a
  // finger drag isn't suppressed by a programmatic smooth scroll the way the
  // wheel is (Chrome/Linux). Kept as a guard for the platform
  // that can't be tested here — iOS Safari, which the relay's phone viewport
  // actually targets, and whose momentum scrolling is a different animal.
  const onTouchMove = (e: TouchIntent) => {
    const y = firstTouchY(e);
    if (y === undefined) return;
    const previousY = touchY.current;
    if (previousY !== null && y !== previousY) navigationTop.current = null;
    if (previousY !== null && y > previousY) setFollowing(false);
    else {
      const el = scrollerRef.current;
      if (el && previousY !== null && touchIntentReachesBottom(el, previousY, y)) {
        setFollowing(true);
      }
    }
    touchY.current = y;
  };

  const followTail = () => {
    const el = scrollerRef.current;
    if (!following.current || !el) return;
    // Instant, and against the scroller directly: see note 1 above.
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  };

  const armFollow = () => {
    navigationTop.current = null;
    setFollowing(true);
  };

  /** The reader asked to come back down (the jump-to-latest pill). */
  const jumpToTail = () => {
    armFollow();
    followTail();
  };

  const isAtBottom = () => {
    const el = scrollerRef.current;
    return Boolean(el && atBottom(el));
  };

  // A shell-owned jump into scrollback is just as intentional as an upward
  // wheel/touch gesture. Own the assignment here so following is disabled
  // before it and the browser-clamped destination is recorded synchronously.
  const scrollToDetached = (top: number) => {
    setFollowing(false);
    const el = scrollerRef.current;
    if (!el) {
      navigationTop.current = null;
      return;
    }
    navigationTop.current = el.scrollTop;
    el.scrollTop = Math.max(0, top);
    navigationTop.current = el.scrollTop;
    lastTop.current = el.scrollTop;
  };

  // Emptying the content collapses scrollTop, which the backstop would
  // otherwise read as the reader scrolling up — so the last position is
  // forgotten along with the content it described.
  const resetTail = () => {
    navigationTop.current = null;
    setFollowing(true);
    lastTop.current = 0;
  };

  return {
    scrollerRef,
    onScroll,
    onWheel,
    onTouchStart,
    onTouchMove,
    followTail,
    armFollow,
    jumpToTail,
    isAtBottom,
    detached,
    scrollToDetached,
    resetTail,
  };
}
