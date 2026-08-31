import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMsg } from "../protocol";
import type { WireMsg } from "../protocol";
import { UnknownKindReporter, ChecklistPainter, PermissionLedger, RenderGuidanceOnce, runSlashTurn } from "./wire-helpers";

const recorder = () => {
  const msgs: WireMsg[] = [];
  return { msgs, emit: (m: WireMsg) => msgs.push(m) };
};
const resolvedFor = (msgs: WireMsg[], id: string) =>
  msgs.filter((m) => m.type === "permission_resolved" && m.id === id);

test("PermissionLedger: an answer resolves the promise and announces exactly one permission_resolved", async () => {
  const { msgs, emit } = recorder();
  const ledger = new PermissionLedger(emit);
  const hows: string[] = [];
  const answered = ledger.ask({ tool: "Bash", detail: "rm -rf /" }, 60_000, (_a, how) => hows.push(how));
  const ask = msgs.find((m) => m.type === "permission_request");
  assert.ok(ask?.type === "permission_request");
  assert.equal(ledger.size, 1);
  assert.equal(ledger.resolve(ask.id, true), true);
  assert.equal(await answered, true);
  assert.equal(resolvedFor(msgs, ask.id).length, 1);
  assert.equal(ledger.size, 0);
  assert.deepEqual(hows, ["answer"]);
  assert.equal(ledger.resolve(ask.id, false), false, "a stale tap is a no-op, never a second resolution");
  assert.equal(resolvedFor(msgs, ask.id).length, 1);
});

test("PermissionLedger: timeout denies; denyAll denies every pending ask with its own resolution", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { msgs, emit } = recorder();
  const ledger = new PermissionLedger(emit);
  const hows: string[] = [];
  const first = ledger.ask({ id: "eng-1", tool: "Read", detail: "a" }, 1_000, (_a, how) => hows.push(how));
  const second = ledger.ask({ tool: "Read", detail: "b", parentId: "spawn-1" }, 1_000, (_a, how) => hows.push(how));
  const secondAsk = msgs.find((m) => m.type === "permission_request" && m.id !== "eng-1");
  assert.ok(secondAsk?.type === "permission_request" && secondAsk.parentId === "spawn-1");
  t.mock.timers.tick(1_000);
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.deepEqual(hows, ["timeout", "timeout"]);

  const third = ledger.ask({ tool: "Write", detail: "c" }, 1_000, (_a, how) => hows.push(how));
  ledger.denyAll("moot");
  assert.equal(await third, false);
  assert.equal(hows.at(-1), "moot");
  assert.equal(msgs.filter((m) => m.type === "permission_resolved").length, 3);
});

test("ChecklistPainter: never paints an empty list first, updates an emptied one in place, re-anchors per turn", () => {
  const { msgs, emit } = recorder();
  const painter = new ChecklistPainter(emit);
  painter.paint([]);
  assert.equal(msgs.length, 0);
  painter.paint([{ content: "a", status: "pending" }]);
  painter.paint([]);
  const renders = msgs.filter((m) => m.type === "render");
  assert.equal(renders.length, 2);
  assert.equal(renders[0].id, renders[1].id, "the emptied list updates the same painting");
  painter.reset();
  painter.paint([{ content: "b", status: "completed" }]);
  assert.notEqual(msgs.filter((m) => m.type === "render")[2].id, renders[0].id);
});

test("RenderGuidanceOnce: carried until delivered, given back on reset", () => {
  const g = new RenderGuidanceOnce("GUIDE");
  assert.equal(g.carry("hi"), "GUIDE\n\n---\n\nhi");
  assert.equal(g.carry("again"), "GUIDE\n\n---\n\nagain", "not consumed until the engine accepted it");
  g.delivered();
  assert.equal(g.carry("later"), "later");
  g.reset();
  assert.equal(g.pending, true);
});

test("runSlashTurn wraps the body in the turn envelope even when it throws", async () => {
  const { msgs, emit } = recorder();
  await assert.rejects(runSlashTurn(emit, () => Promise.reject(new Error("boom"))));
  assert.deepEqual(
    msgs.map((m) => m.type),
    ["status", "turn_end"],
  );
});

// AUDIT 2026-08-26: exactly-once must be structural. A resolution hook that
// re-enters the ledger during a denyAll sweep (the sweep snapshots every
// pending resolver first) previously ran the re-entered ask's finish twice —
// two permission_resolved frames, two engine replies.
test("PermissionLedger: an ask resolved from inside another ask's resolution hook still resolves exactly once", async () => {
  const { msgs, emit } = recorder();
  const ledger = new PermissionLedger(emit);
  const hows: string[] = [];
  let secondId = "";
  const first = ledger.ask({ id: "a", tool: "Read", detail: "a" }, 60_000, () => {
    ledger.resolve(secondId, true); // re-entrant: answers the sibling mid-sweep
  });
  const second = ledger.ask({ tool: "Read", detail: "b" }, 60_000, (_a, how) => hows.push(how));
  secondId = msgs.filter((m) => m.type === "permission_request").map((m) => (m as { id: string }).id)[1]!;
  ledger.denyAll("teardown");
  assert.equal(await first, false);
  assert.equal(await second, true, "the re-entrant answer won");
  assert.deepEqual(hows, ["answer"], "one resolution, not answer-then-teardown");
  assert.equal(resolvedFor(msgs, secondId).length, 1);
  assert.equal(ledger.size, 0);
});


test("UnknownKindReporter logs and notices once per kind per session", () => {
  const emitted: SessionMsg[] = [];
  const warned: string[] = [];
  const r = new UnknownKindReporter((m) => emitted.push(m), "Codex", (m) => warned.push(m));
  r.report("item", "imageView");
  r.report("item", "imageView");
  r.report("event", "imageView"); // same kind, different category — distinct
  assert.equal(warned.length, 2);
  assert.deepEqual(
    emitted.map((m) => (m.type === "notice" ? [m.text, m.kind, m.source] : m.type)),
    [
      ["Mirafold doesn't display this Codex item yet: imageView", "warning", undefined],
      ["Mirafold doesn't display this Codex event yet: imageView", "warning", undefined],
    ],
  );
});
