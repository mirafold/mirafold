import { test } from "node:test";
import assert from "node:assert/strict";
import { startDaemon, TestClient } from "../testing/itest-harness";

// The turn grammar's one invariant, over a real socket: every `user_prompt`
// the daemon admits is answered by exactly one `turn_end`. The shell's
// activity indicator is a counter over those two frames, and it has no way
// back — an orphaned open turn leaves "working…" up for the life of the
// session, on every viewport, healing on neither a later turn nor a reload
// (replay rebuilds the imbalance out of history).
//
// This is pinned at Tier 2 because it took a 1-in-4 Tier-3 flake and a long
// hunt to find: interrupting while a QUEUED turn was also in flight closed
// one turn and orphaned the other. Two open turns is the normal case, not an
// exotic one — the daemon's burst gate deliberately admits one mid-turn
// prompt (terminal parity: typing again while the agent works), so any user
// who types twice and then hits stop was reaching it.

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const counts = (c: TestClient) => ({
  prompts: c.received.filter((m) => m.type === "user_prompt").length,
  ends: c.received.filter((m) => m.type === "turn_end").length,
});

async function session() {
  const d = await startDaemon({ MIRAFOLD_TOKEN: "" });
  const c = new TestClient(d.port);
  await new Promise((r) => c.ws.once("open", r));
  c.ws.send(JSON.stringify({ type: "create", cwd: process.cwd(), agent: "claude-code" }));
  await settle(1_200);
  const send = (msg: object) => c.ws.send(JSON.stringify(msg));
  return { d, c, send, stop: async () => (c.ws.close(), d.stop()) };
}

test("interrupt closes EVERY open turn, not just the one it aborted", async () => {
  const { c, send, stop } = await session();
  try {
    send({ type: "prompt", text: "hello there" }); // turn 1
    await settle(400);
    send({ type: "prompt", text: "second question" }); // turn 2 — the gate admits one
    await settle(400);
    send({ type: "interrupt" });
    await settle(10_000); // generous: any late scheduled frame would land here

    const { prompts, ends } = counts(c);
    assert.equal(prompts, 2, "both prompts were admitted");
    assert.equal(
      ends,
      prompts,
      `the turn grammar broke: ${prompts} prompts answered by ${ends} turn_end frames — ` +
        "an orphaned turn wedges the activity indicator permanently",
    );
  } finally {
    await stop();
  }
});

test("the invariant holds without an interrupt, for a queued turn", async () => {
  const { c, send, stop } = await session();
  try {
    send({ type: "prompt", text: "hello there" });
    await settle(300);
    send({ type: "prompt", text: "second question" });
    await settle(14_000);
    const { prompts, ends } = counts(c);
    assert.equal(prompts, 2);
    assert.equal(ends, prompts, "a queued turn must close on its own");
  } finally {
    await stop();
  }
});
