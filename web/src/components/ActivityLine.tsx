import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  MINI_BASE,
  MINI_SPAN,
  WALKER_SPAN,
  miniMotion,
  miniSprite,
  trackPosition,
  walkerMood,
  walkerSprite,
  type WalkerMood,
} from "../walker";

// The terminal agents' liveness cue, faithfully: an asterisk breathing
// through thin→fat glyph frames beside a ticking elapsed count. Real frame
// changes, not an opacity pulse — and prompt-area chrome, not a transcript
// entry, so no scroll position can hide it. From Enter to turn_end the user
// can always see work is in flight (2026-07-29, Kyle).
//
// Beside it lives the line-walker (2026-08-25, Kyle) — Mirafold's own layer,
// not any engine's: a tiny glyph creature pacing the line's spare width.
// Every move mirrors a real wire fact (walker.ts holds the derivations):
// carrying a ▪ = a tool call is open; sitting with thought-dots = 20s+ of
// uninterrupted thinking; a mini walker = a live subagent, evaporating when
// its root result lands; the bow/flinch outro = how the turn actually ended.
// Decoration, never status: the label + elapsed remain the information.
const FRAMES = ["·", "✢", "✳", "✻", "✽", "✻", "✳", "✢"];
const FRAME_MS = 140;
const OUTRO_MS = 700;
const HOP_MS = 380;
const GHOST_MS = 600;
// A mini added and removed inside this window is a replay burst
// reconstructing history, not a subagent finishing before your eyes — no
// ghost for those, or every reload mid-turn flashes a false farewell.
const GHOST_MIN_LIFE_MS = 800;

// The engine's last known doing, as Shell tracks it off the wire; null =
// nothing specific is known (the generic fallback).
export type Activity = { state: "thinking" | "tool"; label?: string } | null;

/** How the last turn ended — picks the walker's outro (bow, flinch, or
 *  straight offstage for resets/disconnects, where no honest ending exists). */
export type TurnEnd = "done" | "error" | "silent";

// The indicator's wording lives here with the indicator — Shell interprets
// the wire, this file owns the voice.
export const activityLabel = (a: Activity): string =>
  a == null ? "working…" : a.state === "thinking" ? "thinking…" : `${a.label ?? "tool"}…`;

export function ActivityLine({
  busy,
  activity,
  subagents,
  end,
}: {
  busy: boolean;
  activity: Activity;
  subagents: readonly string[];
  end: TurnEnd;
}) {
  // step drives sprite frames; walk drives position and pauses while the
  // walker sits (ponder) so it resumes from where it stopped.
  const [anim, setAnim] = useState({ step: 0, walk: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [hop, setHop] = useState(false);
  const [outro, setOutro] = useState<Extract<WalkerMood, "bow" | "flinch"> | null>(null);
  // Departed minis mid-evaporation; frozen at the cell where they vanished.
  const [ghosts, setGhosts] = useState<{ id: string; cell: number }[]>([]);
  // The stylesheet's global reduced-motion kill switch can't reach these
  // JS-driven frames — honor the preference here, same as the asterisk.
  const [reduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  // Mood needs how long the CURRENT state has held (ponder is earned by
  // dwell, never instant). Render-time ref bookkeeping: the interval below
  // re-renders every frame, so the dwell clock stays current.
  const held = useRef<{ state: "thinking" | "tool" | null; since: number }>({
    state: null,
    since: Date.now(),
  });
  const st = activity?.state ?? null;
  if (held.current.state !== st) held.current = { state: st, since: Date.now() };
  const mood: WalkerMood = walkerMood(st, Date.now() - held.current.since);
  const moodRef = useRef(mood);
  moodRef.current = mood;

  const animRef = useRef(anim);
  animRef.current = anim;
  const lastCell = useRef(0);

  useEffect(() => {
    if (!busy) return;
    setAnim({ step: 0, walk: 0 });
    setElapsed(0);
    const started = Date.now();
    const tick = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    // The glyph cycles from JS, out of reach of the stylesheet's global
    // reduced-motion kill switch — honor the preference here. The elapsed
    // count still ticks: it's information, not motion.
    const spin = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? null
      : window.setInterval(
          () =>
            setAnim((a) => ({
              step: a.step + 1,
              walk: moodRef.current === "ponder" ? a.walk : a.walk + 1,
            })),
          FRAME_MS,
        );
    return () => {
      window.clearInterval(tick);
      if (spin !== null) window.clearInterval(spin);
    };
  }, [busy]);

  // The outro: busy's falling edge plays how the turn really ended, briefly,
  // then the walker is gone. Its own class (never .activity-line) — that
  // selector means "turn in flight" to everything watching it.
  const wasBusy = useRef(busy);
  useEffect(() => {
    const was = wasBusy.current;
    wasBusy.current = busy;
    if (busy) {
      setOutro(null);
      return;
    }
    if (!was || reduced || end === "silent") return;
    setOutro(end === "done" ? "bow" : "flinch");
    const t = window.setTimeout(() => setOutro(null), OUTRO_MS);
    return () => window.clearTimeout(t);
  }, [busy, end, reduced]);

  // Mini departures become ghosts that evaporate in place. Timers are NOT
  // effect cleanups: overlapping departures would cancel each other's
  // removal and strand a ghost forever.
  const prevSubs = useRef<readonly string[]>([]);
  const born = useRef(new Map<string, number>());
  const ghostTimers = useRef<Set<number>>(new Set());
  useEffect(() => {
    const prev = prevSubs.current;
    prevSubs.current = subagents;
    const now = Date.now();
    for (const id of subagents) if (!born.current.has(id)) born.current.set(id, now);
    const gone: { id: string; cell: number }[] = [];
    for (const id of prev) {
      if (subagents.includes(id)) continue;
      const b = born.current.get(id) ?? now;
      born.current.delete(id);
      if (reduced || now - b < GHOST_MIN_LIFE_MS) continue;
      const { phase, speed, drift } = miniMotion(id);
      gone.push({
        id,
        cell:
          MINI_BASE +
          drift +
          trackPosition(Math.floor(animRef.current.walk * speed) + phase, MINI_SPAN).cell,
      });
    }
    if (!gone.length) return;
    setGhosts((g) => [...g, ...gone]);
    const t = window.setTimeout(() => {
      ghostTimers.current.delete(t);
      setGhosts((g) => g.filter((x) => !gone.some((d) => d.id === x.id)));
    }, GHOST_MS);
    ghostTimers.current.add(t);
  }, [subagents, reduced]);
  useEffect(
    () => () => {
      for (const t of ghostTimers.current) window.clearTimeout(t);
    },
    [],
  );

  const track = (children: ReactNode) => (
    <span className="walker-track">{children}</span>
  );
  const ghostSpans = ghosts.map((g) => (
    <span key={g.id} className="walker-mini is-ghost" style={{ left: `${g.cell}ch` }}>
      {miniSprite(0, 0)}
    </span>
  ));

  if (!busy) {
    if (!outro && ghosts.length === 0) return null;
    return (
      // aria-hidden like the line itself: the Announcer already spoke the
      // turn's ending; this is the walker's farewell, not information.
      <div className="walker-outro" aria-hidden="true">
        {track(
          <>
            {ghostSpans}
            {outro && (
              <span className="walker" style={{ left: `${lastCell.current}ch` }}>
                {walkerSprite(outro, 0, 1)}
              </span>
            )}
          </>,
        )}
      </div>
    );
  }

  const { cell, facing } = trackPosition(anim.walk, WALKER_SPAN);
  lastCell.current = cell;
  return (
    // aria-hidden: Announcer speaks turn state once per transition (A.1);
    // a line whose text changes every second would drown a screen reader.
    <div className="activity-line" aria-hidden="true">
      <span className="activity-glyph">{FRAMES[anim.step % FRAMES.length]}</span>
      <span className="activity-label">{activityLabel(activity)}</span>
      <span className="activity-elapsed">({elapsed}s)</span>
      {track(
        <>
          {subagents.map((id) => {
            const { phase, speed, drift } = miniMotion(id);
            const p = trackPosition(Math.floor(anim.walk * speed) + phase, MINI_SPAN);
            return (
              <span key={id} className="walker-mini" style={{ left: `${MINI_BASE + drift + p.cell}ch` }}>
                {miniSprite(anim.step, phase)}
              </span>
            );
          })}
          {ghostSpans}
          <span
            className={"walker" + (hop ? " is-hop" : "")}
            style={{ left: `${cell}ch` }}
            onClick={() => {
              // A no-op by design (it hops; nothing about the turn changes) —
              // anything more would make a decoration claim agency it lacks.
              if (hop) return;
              setHop(true);
              window.setTimeout(() => setHop(false), HOP_MS);
            }}
          >
            {walkerSprite(mood, anim.step, facing)}
          </span>
        </>,
      )}
    </div>
  );
}
