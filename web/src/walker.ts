// The line-walker (2026-08-25, Kyle): the ActivityLine's resident glyph
// creature. Everything here is a pure derivation so Tier 1 can pin it
// without a DOM; ActivityLine.tsx owns the timers and the rendering.
//
// The honesty rule the whole toy lives under: every behavior is driven by a
// REAL wire fact — the walker carries a box only while a tool call is
// actually open, ponders only after real uninterrupted thinking, and a mini
// exists only while a real subagent's records are arriving. Nothing it does
// is invented status.

/** What the walker is doing, derived from the engine's real state. */
export type WalkerMood = "walk" | "carry" | "ponder" | "bow" | "flinch";

/** Uninterrupted thinking longer than this reads as a hard problem — the
 *  walker stops pacing and sits with it. */
export const PONDER_AFTER_MS = 20_000;

/** The walker roams this many character cells; minis get their own span
 *  (their glyphs render smaller, so their `ch` is smaller too — the larger
 *  count keeps their roam visually comparable). The track clips overflow,
 *  so a narrow viewport just sends the far end of a roam offstage. */
export const WALKER_SPAN = 16;
export const MINI_SPAN = 16;
/** Minis parade on their own stretch of track, right of the walker's roam
 *  (span + widest sprite) — the family never mashes glyphs. */
export const MINI_BASE = 24;

export function walkerMood(
  state: "thinking" | "tool" | null,
  dwellMs: number,
): WalkerMood {
  if (state === "tool") return "carry";
  if (state === "thinking" && dwellMs >= PONDER_AFTER_MS) return "ponder";
  return "walk";
}

/** Triangle-wave pacing: 0 → span → 0, one cell per step, facing flips at
 *  the ends. Character-stepped on purpose — discrete `ch` jumps are the
 *  terminal-native gait, not a smooth tween. */
export function trackPosition(step: number, span: number): { cell: number; facing: 1 | -1 } {
  if (span <= 0) return { cell: 0, facing: 1 };
  const period = span * 2;
  const p = ((step % period) + period) % period;
  return p <= span ? { cell: p, facing: 1 } : { cell: period - p, facing: -1 };
}

const FACE = "(•ᴗ•)";
const BLINK = "(-ᴗ-)";

/** The sprite for a mood at a tick. `carry` holds its ▪ on the side it's
 *  walking toward; `ponder` sits with a growing thought-dot trail. */
export function walkerSprite(mood: WalkerMood, step: number, facing: 1 | -1): string {
  switch (mood) {
    case "carry":
      return facing === 1 ? `${FACE}⊃▪` : `▪⊂${FACE}`;
    case "ponder":
      return `${FACE} ${"˙".repeat((step % 3) + 1)}`;
    case "bow":
      return "(_ _)";
    case "flinch":
      return "(>▂<)";
    default:
      // step 0 must show open eyes — it's the parked reduced-motion frame.
      return step % 7 === 6 ? BLINK : FACE;
  }
}

/** Per-mini gait, derived from the subagent's id so two minis never pace in
 *  lockstep — deterministic (replay-stable), no randomness. `drift` shifts
 *  the whole roam rightward so the family spreads into a parade instead of
 *  tangling on one spot. */
export function miniMotion(id: string): { phase: number; speed: number; drift: number } {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return { phase: h % 29, speed: 0.5 + ((h >>> 5) % 4) * 0.25, drift: (h >>> 9) % 14 };
}

export function miniSprite(step: number, phase: number): string {
  return walkerSprite("walk", step + phase, 1);
}

/** Which record types prove a subagent is alive. Name-agnostic like the
 *  deck (subagent-deck.ts): a "subagent" is any tool_use id that other
 *  records reference as their parentId — never a tool-name match. */
const CHILD_TYPES = new Set([
  "tool_use",
  "tool_result",
  "text_delta",
  "thinking_delta",
  "permission_request",
]);

/** The live-subagent roster, folded off the wire (same reducer idiom as
 *  turn-busy.ts). A mini materializes on the first record carrying a new
 *  parentId — the moment the subagent actually does something — and
 *  dematerializes when the spawn's own root tool_result lands (the deck's
 *  "output set → done" fact, id-matched, no parentId). Turn boundaries and
 *  resets clear the lot: a turn's subagents never outlive it.
 *  Returns `current` unchanged (same reference) when nothing moved. */
export function nextSubagents(
  current: readonly string[],
  m: { type: string; id?: string; parentId?: string },
): readonly string[] {
  if (m.type === "turn_end" || m.type === "error" || m.type === "zone_reset") {
    return current.length ? [] : current;
  }
  if (m.parentId && CHILD_TYPES.has(m.type)) {
    return current.includes(m.parentId) ? current : [...current, m.parentId];
  }
  if (m.type === "tool_result" && m.id !== undefined && current.includes(m.id)) {
    return current.filter((x) => x !== m.id);
  }
  return current;
}
