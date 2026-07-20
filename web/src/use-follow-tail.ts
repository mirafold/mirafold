import { useRef } from "react";

/**
 * Follow-the-tail for a scrolling transcript, CONDITIONAL the way a terminal's
 * scrollback is: new output scrolls the reader down only while they're already
 * at the bottom. Scroll up and the view freezes where they put it — output
 * keeps landing below, out of sight — until they come back down.
 *
 * Wire it up with all three parts: `scrollerRef` on the scrolling element,
 * `tailRef` on a sentinel as its last child, `onScroll` as its handler. Then
 * call `followTail()` from an effect keyed on whatever changes the content,
 * `armFollow()` when the reader is conceptually back at the bottom (they sent
 * a message), and `resetTail()` when the content is replaced wholesale.
 */

// A line or two of slack: pixel-exact bottom is unreachable with fractional
// scroll heights, and one stray trackpad nudge shouldn't detach follow for good.
const BOTTOM_SLACK_PX = 48;

export function useFollowTail() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);

  // Detaching keys off DIRECTION, not "am I at the bottom": our own smooth
  // scroll fires events from positions that aren't the bottom yet, and a
  // bottom test would read those as the reader leaving.
  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollTop < lastTop.current - 1) following.current = false;
    if (scrollHeight - scrollTop - clientHeight <= BOTTOM_SLACK_PX) following.current = true;
    lastTop.current = scrollTop;
  };

  const followTail = () => {
    if (following.current) tailRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const armFollow = () => {
    following.current = true;
  };

  // Emptying the content collapses scrollTop, which the direction test would
  // otherwise read as the reader scrolling up — so the last position is
  // forgotten along with the content it described.
  const resetTail = () => {
    following.current = true;
    lastTop.current = 0;
  };

  return { scrollerRef, tailRef, onScroll, followTail, armFollow, resetTail };
}
