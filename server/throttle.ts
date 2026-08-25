// "Not too fast", in the shapes the daemon's request paths need. Every taker
// answers a plain boolean and never throws: a refused take is a reply the
// caller owes the sender (protocol rule — every well-formed request gets
// exactly one reply, an error rides the reply, never silence). The per-
// SESSION `!` burst gate is the one exception to per-connection scope and
// keeps its own clock on the session entry (bang-handlers.ts): it protects
// model tokens, which every viewport of that session shares.

/** The one refusal line a rate-limited request gets, whichever path. */
export const TOO_FAST = "requests are arriving too fast — retry shortly";

/** At most one take per `ms` window. */
export function minInterval(ms: number, now: () => number = Date.now): { take(): boolean } {
  let last = -Infinity;
  return {
    take() {
      const at = now();
      if (at - last < ms) return false;
      last = at;
      return true;
    },
  };
}

/** Up to `perSecond` takes in any one-second window, refilled continuously
 *  and capped at one full burst — a panel opening legitimately fetches a
 *  root plus its first level at once. */
export function tokenBucket(perSecond: number, now: () => number = Date.now): { take(): boolean } {
  let tokens = perSecond;
  let refilledAt = now();
  return {
    take() {
      const at = now();
      tokens = Math.min(perSecond, tokens + ((at - refilledAt) / 1_000) * perSecond);
      refilledAt = at;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/** One in-flight operation at a time; `release()` when it settles. */
export function inflightSlot(): { take(): boolean; release(): void; readonly busy: boolean } {
  let busy = false;
  return {
    take() {
      if (busy) return false;
      busy = true;
      return true;
    },
    release() {
      busy = false;
    },
    get busy() {
      return busy;
    },
  };
}
