import { useRef, useState } from "react";

// How long an armed control stays armed before quietly stepping down.
const DISARM_MS = 3_000;

/**
 * The arming core, hook-free so node:test can drive it (the repo has no DOM
 * harness). Each arm() bumps a generation, and a timer stands down only its
 * OWN generation: identifying the owner by key value alone let an older
 * timer cut a re-armed SAME key short — armed for 1s instead of 3, so the
 * user's confirm click re-armed instead of firing (2026-07-29 bughunt).
 */
export class ArmerCore<K> {
  private gen = 0;
  constructor(
    private set: (updater: (cur: K | null) => K | null) => void,
    private schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  ) {}
  arm(key: K) {
    const g = ++this.gen;
    this.set(() => key);
    this.schedule(() => {
      if (this.gen === g) this.set((cur) => (cur === key ? null : cur));
    }, DISARM_MS);
  }
  disarm() {
    this.set(() => null);
  }
}

/**
 * Two-click confirm for a destructive control (#11): the first click ARMS the
 * key ("end" → "end?"), a second click within a few seconds is the real
 * action, and doing nothing disarms. `K` is whatever identifies the armed
 * control — a session id where many rows share the state, `true` where one
 * control owns it. A timeout stands down only its own arming (key AND
 * generation), so neither a different key nor a re-armed same key is cut
 * short by an earlier timer.
 */
export function useArmedConfirm<K>() {
  const [armed, setArmed] = useState<K | null>(null);
  const core = useRef<ArmerCore<K> | null>(null);
  core.current ??= new ArmerCore<K>((updater) => setArmed(updater));
  return {
    armed,
    arm: (key: K) => core.current!.arm(key),
    disarm: () => core.current!.disarm(),
  };
}
