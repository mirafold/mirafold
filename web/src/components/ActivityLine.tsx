import { useEffect, useState } from "react";
import { visibleControls } from "../visible-controls";

// The terminal agents' liveness cue, faithfully: an asterisk breathing
// through thin→fat glyph frames beside a ticking elapsed count. Real frame
// changes, not an opacity pulse — and prompt-area chrome, not a transcript
// entry, so no scroll position can hide it. From Enter to turn_end the user
// can always see work is in flight.
const FRAMES = ["·", "✢", "✳", "✻", "✽", "✻", "✳", "✢"];
const FRAME_MS = 140;

// The engine's last known doing, as Shell tracks it off the wire; null =
// nothing specific is known (the generic fallback).
export type Activity = { state: "thinking" | "tool"; label?: string } | null;

// The indicator's wording lives here with the indicator — Shell interprets
// the wire, this file owns the voice.
export const activityLabel = (a: Activity): string =>
  a == null ? "working…" : a.state === "thinking" ? "thinking…" : `${a.label ?? "tool"}…`;

export function ActivityLine({ busy, label }: { busy: boolean; label: string }) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!busy) return;
    setFrame(0);
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
      : window.setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS);
    return () => {
      window.clearInterval(tick);
      if (spin !== null) window.clearInterval(spin);
    };
  }, [busy]);

  if (!busy) return null;
  return (
    // aria-hidden: Announcer speaks turn state once per transition;
    // a line whose text changes every second would drown a screen reader.
    <div className="activity-line" aria-hidden="true">
      <span className="activity-glyph">{FRAMES[frame]}</span>
      <span className="activity-label">{visibleControls(label)}</span>
      <span className="activity-elapsed">({elapsed}s)</span>
    </div>
  );
}
