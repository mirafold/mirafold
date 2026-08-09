import { useRef } from "react";

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
 * wholesale.
 *
 * Two decisions here were bought with a bug (2026-07-20, traced in a real
 * browser — don't undo either without re-reading that trace):
 *
 *  1. **Following scrolls INSTANTLY, never smoothly.** A smooth scroll is an
 *     animation, and during streaming `followTail` fires every ~35ms, so the
 *     animation was permanently in flight. While it runs it owns `scrollTop`:
 *     the reader's wheel deltas were overwritten by the next animation frame
 *     and never became scroll events at all — the wheel was inert. It also
 *     could never catch a tail growing faster than it animates, leaving a
 *     "following" reader ~5000px behind the live output.
 *  2. **The reader's INPUT is what detaches, not a position delta.** A wheel
 *     or touch drag says "the reader is steering" whether or not the viewport
 *     ends up moving, so it can't be suppressed the way a delta can. The
 *     position test stays as a backstop for the scrolls that have no input
 *     event of their own — a scrollbar drag, find-in-page, a keyboard scroll
 *     — and is trustworthy now that our own scrolls are single downward jumps
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
  const lastTop = useRef(0);
  const touchY = useRef<number | null>(null);

  const atBottom = (el: HTMLElement) => bottomGap(el) <= BOTTOM_SLACK_PX;

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    // The backstop: an upward move we got no input event for.
    if (el.scrollTop < lastTop.current - 1) following.current = false;
    if (atBottom(el)) following.current = true;
    lastTop.current = el.scrollTop;
  };

  // Steering UP detaches. A gesture that will reach the current bottom arms
  // synchronously: waiting for onScroll is racy because streamed paint can
  // move the bottom by more than the slack before that event runs.
  const onWheel = (e: WheelIntent) => {
    if (e.deltaY < 0) {
      following.current = false;
      return;
    }
    const el = scrollerRef.current;
    if (el && wheelIntentReachesBottom(el, e)) following.current = true;
  };

  const onTouchStart = (e: TouchIntent) => {
    touchY.current = firstTouchY(e) ?? null;
  };

  // Dragging the content DOWN scrolls the transcript up — the touch equivalent
  // of a negative wheel delta.
  //
  // Verified to fire and detach on a real emulated-touch swipe, but NOT proven
  // necessary: touch already held correctly without these handlers, because a
  // finger drag isn't suppressed by a programmatic smooth scroll the way the
  // wheel was (Chrome/Linux, 2026-07-20). Kept as a guard for the platform
  // that can't be tested here — iOS Safari, which the relay's phone viewport
  // actually targets, and whose momentum scrolling is a different animal.
  const onTouchMove = (e: TouchIntent) => {
    const y = firstTouchY(e);
    if (y === undefined) return;
    const previousY = touchY.current;
    if (previousY !== null && y > previousY) following.current = false;
    else {
      const el = scrollerRef.current;
      if (el && previousY !== null && touchIntentReachesBottom(el, previousY, y)) {
        following.current = true;
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
    following.current = true;
  };

  // Emptying the content collapses scrollTop, which the backstop would
  // otherwise read as the reader scrolling up — so the last position is
  // forgotten along with the content it described.
  const resetTail = () => {
    following.current = true;
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
    resetTail,
  };
}
