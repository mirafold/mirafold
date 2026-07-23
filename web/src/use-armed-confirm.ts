import { useState } from "react";

// How long an armed control stays armed before quietly stepping down.
const DISARM_MS = 3_000;

/**
 * Two-click confirm for a destructive control (#11): the first click ARMS the
 * key ("end" → "end?"), a second click within a few seconds is the real
 * action, and doing nothing disarms. `K` is whatever identifies the armed
 * control — a session id where many rows share the state, `true` where one
 * control owns it. The timeout only stands down its own key, so re-arming a
 * different key isn't cancelled by the first key's timer.
 */
export function useArmedConfirm<K>() {
  const [armed, setArmed] = useState<K | null>(null);
  const arm = (key: K) => {
    setArmed(key);
    setTimeout(() => setArmed((cur) => (cur === key ? null : cur)), DISARM_MS);
  };
  return { armed, arm, disarm: () => setArmed(null) };
}
