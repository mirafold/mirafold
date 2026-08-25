// The open-turn counter behind the activity indicator: user_prompt
// opens a turn, turn_end closes one, and a queued follow-up keeps busy
// across the boundary because the count stays >0. Extracted pure so Tier 1
// can pin it without a DOM harness.
//
// The floor rule: REPLAYED turn activity implies an
// open turn. A disconnect zeroes the counter, and a tail resume never
// replays the in-flight turn's user_prompt — so without the floor a queued
// follow-up's first turn_end would take the count 1→0 and blank the indicator
// across the engine roll-in. The floor applies ONLY to replay-stamped frames: a mid-turn drop
// always leaves missed frames to replay, so the resume case is covered —
// while a LIVE straggler after a final turn_end (the mock's overlay
// behavior emits exactly those) must not re-open a closed turn, or busy
// wedges on with no turn_end ever coming.

import type { ZoneMsg } from "./session-bus";

const ACTIVITY_TYPES = new Set<ZoneMsg["type"]>(["status", "thinking_delta", "text_delta", "tool_use"]);

// Terminal for a turn — the SAME set the daemon uses to decide a session went
// idle and to clear its burst gate (`server/sessions/registry.ts`: "turn_end
// || error → idle"). Mirroring it is the point: when the two disagree, the
// daemon knows the session is idle while the shell shows "working…" forever.
//
// Why forever, and why this matters:
// a turn that ends by `error` — an adapter crash, an engine dying mid-stream,
// a dropped frame — emits no `turn_end`, so the count never comes down. A
// reload does NOT heal it either: replay reconstructs the same imbalance out
// of history, so the indicator reads busy for the life of that session, on
// every viewport.
//
// The tradeoff, stated plainly: with two turns genuinely in flight, an error
// closing one may read idle a beat early. That self-heals on the very next
// activity frame (Shell re-arms busy on any of ACTIVITY_TYPES), whereas a
// permanent wedge never heals at all. Transient wrong beats permanent wrong.
const TERMINAL_TYPES = new Set<ZoneMsg["type"]>(["turn_end", "error"]);

export function nextOpenTurns(current: number, msgType: ZoneMsg["type"], replayed = false): number {
  if (msgType === "user_prompt") return current + 1;
  if (TERMINAL_TYPES.has(msgType)) return Math.max(0, current - 1);
  if (replayed && ACTIVITY_TYPES.has(msgType)) return Math.max(current, 1);
  return current;
}
