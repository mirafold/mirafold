// The open-turn counter behind the activity indicator (4.14): user_prompt
// opens a turn, turn_end closes one, and a queued follow-up keeps busy
// across the boundary because the count stays >0. Extracted pure so Tier 1
// can pin it — the 4.14 caveat's asked-for "Shell-level unit test", without
// a DOM harness.
//
// The floor rule (2026-07-29 bughunt): REPLAYED turn activity implies an
// open turn. A disconnect zeroes the counter, and a tail resume never
// replays the in-flight turn's user_prompt — so without the floor a queued
// follow-up's first turn_end took the count 1→0 and blanked the indicator
// across the engine roll-in, the exact gap 4.14 closed on the straight-line
// path. The floor applies ONLY to replay-stamped frames: a mid-turn drop
// always leaves missed frames to replay, so the resume case is covered —
// while a LIVE straggler after a final turn_end (the mock's overlay
// behavior emits exactly those) must not re-open a closed turn, or busy
// wedges on with no turn_end ever coming.

const ACTIVITY_TYPES = new Set(["status", "thinking_delta", "text_delta", "tool_use"]);

export function nextOpenTurns(current: number, msgType: string, replayed = false): number {
  if (msgType === "user_prompt") return current + 1;
  if (msgType === "turn_end") return Math.max(0, current - 1);
  if (replayed && ACTIVITY_TYPES.has(msgType)) return Math.max(current, 1);
  return current;
}
