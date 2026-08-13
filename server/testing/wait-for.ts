/** Poll `cond` until true or the deadline — the shape async adapter tests
 *  share (worker turns land on their own schedule; tests observe, never
 *  await internals). Rejection names `what` so a timeout reads as a claim. */
export const waitFor = (cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (cond()) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 5);
  });
