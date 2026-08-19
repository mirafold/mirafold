/** Poll `cond` until true or the deadline — the shape async adapter tests
 *  share (worker turns land on their own schedule; tests observe, never
 *  await internals). Rejection names `what`, and an optional `detail()` is
 *  appended so a TIMEOUT is diagnosable instead of blind — load-bearing for
 *  the real-process live tier, where an occasional timing wobble otherwise
 *  fails with no clue what state it was in (test-audit 2026-08-13). */
export const waitFor = (
  cond: () => boolean,
  what: string,
  timeoutMs = 5_000,
  detail?: () => string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (cond()) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(poll);
        const extra = detail ? ` — ${detail()}` : "";
        reject(new Error(`timed out waiting for ${what} (${timeoutMs}ms)${extra}`));
      }
    }, 5);
  });
