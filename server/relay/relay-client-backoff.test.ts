// The slow-refusal backoff pin (2026-07-30, found live against production):
// Fly's proxy delivers a refusal close ~5 s after 'open' — long past the
// pair-confirm window — so a timer-based backoff reset read every refused
// dial as healthy and an invalid/lapsed license churn-dialed at ~6 s forever.
// The rule under test: a REFUSAL close never resets backoff, however late it
// arrives; a confirmed connection's ordinary drop still resets to the floor.
//
// Fast knobs must be in the env BEFORE the module loads, hence the dynamic
// import (a static import would hoist above the assignments). Own file =
// own node --test child process, so nothing else sees these values.
process.env.RELAY_PAIR_CONFIRM_MS = "50";
process.env.RELAY_RECONNECT_MIN_MS = "200";
process.env.RELAY_RECONNECT_MAX_MS = "3200";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { SessionRegistry } from "../sessions/registry";

const { startRelayClient } = await import("./relay-client");
const { CLOSE_UNENTITLED } = await import("./relay-protocol");

/** Loopback relay that scripts each accepted dial: `plan[i]` closes dial i
 *  with a code after a delay. Resolves once `plan.length + 1` dials arrived
 *  (the extra one proves the post-plan redial), reporting arrival times. */
function scriptedRelay(
  plan: Array<{ afterMs: number; code: number }>,
): Promise<{ port: number; dialTimes: Promise<number[]>; close: () => void }> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const times: number[] = [];
  let done!: (t: number[]) => void;
  const dialTimes = new Promise<number[]>((r) => (done = r));
  server.on("upgrade", (req, socket, head) => {
    times.push(Date.now());
    const i = times.length - 1;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const step = plan[i];
      if (step) setTimeout(() => ws.close(step.code), step.afterMs);
      else done([...times]); // one dial past the plan — enough to measure
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as { port: number }).port,
        dialTimes,
        close: () => {
          for (const ws of wss.clients) ws.terminate();
          server.close();
        },
      }),
    ),
  );
}

test("a refusal arriving AFTER the confirm window still widens the retry gaps", async () => {
  // Both refusals land at 120 ms — past the 50 ms confirm, the production
  // shape. Under the timer-reset bug the two gaps come out equal (~320 ms);
  // under the fix the second is one doubling wider.
  const relay = await scriptedRelay([
    { afterMs: 120, code: CLOSE_UNENTITLED },
    { afterMs: 120, code: CLOSE_UNENTITLED },
  ]);
  const client = startRelayClient({
    url: `ws://127.0.0.1:${relay.port}`,
    code: "a-strong-pairing-code-for-tests",
    registry: {} as SessionRegistry, // no viewport ever opens here
  });
  const t = await relay.dialTimes;
  client.stop();
  relay.close();
  const gap1 = t[1] - t[0]; // ≈ 120 close + 200 floor
  const gap2 = t[2] - t[1]; // ≈ 120 close + 400 widened — NOT 200 again
  assert.ok(
    gap2 > gap1 + 100,
    `retry gaps must widen through a late refusal: gap1=${gap1}ms gap2=${gap2}ms`,
  );
});

test("a confirmed connection's ordinary drop still resets backoff to the floor", async () => {
  // Two late refusals widen the backoff (pending: 800 ms), then a healthy
  // connection (open past confirm) drops normally — the next dial must come
  // at the 200 ms floor again, not the widened value.
  const relay = await scriptedRelay([
    { afterMs: 120, code: CLOSE_UNENTITLED },
    { afterMs: 120, code: CLOSE_UNENTITLED },
    { afterMs: 150, code: 1000 }, // confirmed (50 ms) then an ordinary close
  ]);
  const client = startRelayClient({
    url: `ws://127.0.0.1:${relay.port}`,
    code: "a-strong-pairing-code-for-tests",
    registry: {} as SessionRegistry,
  });
  const t = await relay.dialTimes;
  client.stop();
  relay.close();
  const afterHealthy = t[3] - t[2]; // ≈ 150 close + 200 reset floor
  assert.ok(
    afterHealthy < 600,
    `after a healthy drop the redial must start from the floor: ${afterHealthy}ms (unreset would be ≥950ms)`,
  );
});
