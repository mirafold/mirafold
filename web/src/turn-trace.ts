// Opt-in trace of the open-turn counter's inputs (2026-07-30).
//
// The counter behind the activity indicator (turn-busy.ts) wedged above zero
// in a Tier-3 run: the indicator read "working…" for 30s while the polite
// live region already held the finished response, i.e. `turn_end` had
// arrived. A stuck counter can only be explained by the SEQUENCE of frames
// that moved it — which frame types, live or replayed, and what the count did
// on each. Reasoning about it from the source produced a confident hypothesis
// that a direct probe then falsified, so: record the sequence instead.
//
// Costs one `Array.isArray` per received frame unless a harness has armed it
// by setting `window.__MIRAFOLD_TURN_TRACE__ = []` before the app boots.
// An armed ring records the frame type, the replay flag, the two counter
// values, and — for `user_prompt` only — a 24-character prefix of the prompt,
// which is what lets a wedge name the turn that caused it. That prefix is the
// one piece of CONTENT here, and it is why arming is a test-harness act: no
// product path sets the global, so nothing is recorded in a user's browser.

const CAP = 400;

export function traceTurn(type: string, replayed: boolean, from: number, to: number, label?: string): void {
  const ring = (globalThis as unknown as { __MIRAFOLD_TURN_TRACE__?: unknown }).__MIRAFOLD_TURN_TRACE__;
  if (!Array.isArray(ring)) return;
  ring.push(`${type}${replayed ? "*" : ""} ${from}->${to}${label ? ` «${label.slice(0, 24)}»` : ""}`);
  if (ring.length > CAP) ring.splice(0, ring.length - CAP);
}
