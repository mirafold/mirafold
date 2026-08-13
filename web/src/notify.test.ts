import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNotifier,
  decideNotifications,
  folderTitle,
  type NotificationHandle,
  type NotifyAction,
  type NotifyEntry,
  type NotifyFlags,
  type NotifyState,
  type SessionSnapshot,
} from "./notify";

const HIDDEN: NotifyFlags = { enabled: true, granted: true, visible: false };
const VISIBLE: NotifyFlags = { enabled: true, granted: true, visible: true };

const snap = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id: "s1",
  state: "idle",
  title: "mirafold",
  agent: "claude",
  ...over,
});

const prev = (entries: [string, NotifyState | NotifyEntry][]) =>
  new Map(entries.map(([id, v]) => [id, typeof v === "string" ? { state: v } : v] as const));

test("a permission appearing in a hidden tab toasts once, shell-composed", () => {
  const { actions, states } = decideNotifications(
    prev([["s1", "busy"]]),
    [snap({ state: "permission", tool: "Bash", detail: "git push origin main" })],
    HIDDEN,
  );
  assert.equal(actions.length, 1);
  const a = actions[0];
  assert.equal(a.kind, "show");
  assert.equal(a.kind === "show" && a.event, "permission");
  assert.equal(a.kind === "show" && a.title, "⚠ permission — mirafold");
  assert.equal(a.kind === "show" && a.body, "claude wants Bash: git push origin main");
  assert.equal(states.get("s1")?.state, "permission");
});

test("a session first seen already blocked on permission toasts — a background tab discovering a stalled session is the point", () => {
  const { actions } = decideNotifications(new Map(), [snap({ state: "permission", tool: "Bash" })], HIDDEN);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "show");
  assert.equal(actions[0].kind === "show" && actions[0].body, "claude wants Bash.");
});

test("first sight of busy or idle stays silent — no evidence a turn just ended", () => {
  assert.equal(decideNotifications(new Map(), [snap({ state: "busy" })], HIDDEN).actions.length, 0);
  assert.equal(decideNotifications(new Map(), [snap({ state: "idle" })], HIDDEN).actions.length, 0);
});

test("busy→idle toasts a turn end", () => {
  const { actions } = decideNotifications(prev([["s1", "busy"]]), [snap()], HIDDEN);
  assert.equal(actions.length, 1);
  const a = actions[0];
  assert.equal(a.kind === "show" && a.event, "turn-end");
  assert.equal(a.kind === "show" && a.title, "✓ turn finished — mirafold");
  assert.equal(a.kind === "show" && a.body, "claude is waiting for your next prompt.");
});

test("permission→idle toasts the turn end (answered + finished while away)", () => {
  const { actions } = decideNotifications(prev([["s1", "permission"]]), [snap()], HIDDEN);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind === "show" && actions[0].event, "turn-end");
});

test("permission→busy closes — the ask was answered elsewhere", () => {
  const { actions } = decideNotifications(
    prev([["s1", "permission"]]),
    [snap({ state: "busy" })],
    HIDDEN,
  );
  assert.deepEqual(actions, [{ kind: "close", id: "s1" }]);
});

test("a visible tab suppresses shows but still consumes the transition", () => {
  const first = decideNotifications(prev([["s1", "busy"]]), [snap({ state: "permission" })], VISIBLE);
  assert.equal(first.actions.length, 0);
  // Backgrounding later must not replay the already-seen edge through decide
  // (the binder's visibility hook owns the still-pending re-toast).
  const second = decideNotifications(first.states, [snap({ state: "permission" })], HIDDEN);
  assert.equal(second.actions.length, 0);
});

test("a visible tab still emits the close when a turn ends", () => {
  const { actions } = decideNotifications(prev([["s1", "permission"]]), [snap()], VISIBLE);
  assert.deepEqual(actions, [{ kind: "close", id: "s1" }]);
});

test("disabled or ungranted emit nothing but keep tracking state", () => {
  for (const flags of [
    { ...HIDDEN, enabled: false },
    { ...HIDDEN, granted: false },
  ]) {
    const { actions, states } = decideNotifications(
      prev([["s1", "busy"]]),
      [snap({ state: "permission" })],
      flags,
    );
    assert.equal(actions.length, 0);
    assert.equal(states.get("s1")?.state, "permission");
  }
});

test("a vanished session closes its toast", () => {
  const { actions, states } = decideNotifications(prev([["s1", "permission"]]), [], HIDDEN);
  assert.deepEqual(actions, [{ kind: "close", id: "s1" }]);
  assert.equal(states.size, 0);
});

test("sessions transition independently", () => {
  const { actions } = decideNotifications(
    prev([
      ["a", "busy"],
      ["b", "permission"],
      ["c", "idle"],
    ]),
    [
      snap({ id: "a", state: "permission", title: "api", tool: "Bash" }),
      snap({ id: "b", state: "busy", title: "web" }),
      snap({ id: "c", state: "idle", title: "docs" }),
    ],
    HIDDEN,
  );
  const kinds = actions.map((a: NotifyAction) => `${a.kind}:${a.id}`);
  assert.deepEqual(kinds, ["show:a", "close:b"]);
});

test("an unchanged state emits nothing", () => {
  const { actions } = decideNotifications(
    prev([["s1", { state: "permission", askKey: "\0" }]]),
    [snap({ state: "permission" })],
    HIDDEN,
  );
  assert.equal(actions.length, 0);
});

test("permission→permission with a DIFFERENT ask refreshes the toast", () => {
  // Ask A answered elsewhere; the agent immediately raises ask B while the
  // tab stays hidden. The toast must show B, not keep A's text (bughunt
  // 2026-08-13). Same ask twice stays silent.
  const first = decideNotifications(
    prev([["s1", "busy"]]),
    [snap({ state: "permission", tool: "Bash", detail: "rm -rf build" })],
    HIDDEN,
  );
  assert.equal(first.actions.length, 1);
  const second = decideNotifications(
    first.states,
    [snap({ state: "permission", tool: "Write", detail: "notes.md" })],
    HIDDEN,
  );
  assert.equal(second.actions.length, 1);
  const b = second.actions[0];
  assert.equal(b.kind === "show" && b.body, "claude wants Write: notes.md");
  const third = decideNotifications(
    second.states,
    [snap({ state: "permission", tool: "Write", detail: "notes.md" })],
    HIDDEN,
  );
  assert.equal(third.actions.length, 0, "the SAME ask never re-toasts");
});

test("a runaway permission detail is capped for the OS surface", () => {
  const { actions } = decideNotifications(
    new Map(),
    [snap({ state: "permission", tool: "Bash", detail: "x".repeat(500) })],
    HIDDEN,
  );
  const body = actions[0].kind === "show" ? actions[0].body : "";
  assert.equal(body.length, 160);
  assert.ok(body.endsWith("…"));
});

test("folderTitle takes the last path segment and survives absence", () => {
  assert.equal(folderTitle("/home/kyle/Projects/mirafold"), "mirafold");
  assert.equal(folderTitle("/"), undefined);
  assert.equal(folderTitle(undefined), undefined);
});

// ---- binder ----

class FakeToast implements NotificationHandle {
  closed = false;
  onclick: (() => void) | null = null;
  constructor(public opts: { tag: string; title: string; body: string }) {}
  close() {
    this.closed = true;
  }
}

function harness(over: { visible?: boolean; enabled?: boolean; granted?: boolean } = {}) {
  const spawned: FakeToast[] = [];
  const state = { visible: over.visible ?? false, enabled: over.enabled ?? true, granted: over.granted ?? true, focused: 0 };
  const notifier = createNotifier({
    enabled: () => state.enabled,
    granted: () => state.granted,
    visible: () => state.visible,
    spawn: (o) => {
      const t = new FakeToast(o);
      spawned.push(t);
      return t;
    },
    focus: () => state.focused++,
  });
  return { notifier, spawned, state };
}

test("binder: a toast carries the session tag; the next event retires the old handle", () => {
  const { notifier, spawned } = harness();
  notifier.update([snap({ state: "permission", tool: "Bash" })]);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].opts.tag, "mirafold-s1");
  notifier.update([snap({ state: "idle" })]);
  assert.equal(spawned.length, 2, "turn-end toast replaces the permission one");
  assert.equal(spawned[0].closed, true);
  assert.equal(spawned[1].closed, false);
});

test("binder: resolution elsewhere closes the live toast", () => {
  const { notifier, spawned } = harness();
  notifier.update([snap({ state: "permission" })]);
  notifier.update([snap({ state: "busy" })]);
  assert.equal(spawned[0].closed, true);
});

test("binder: reset closes everything and reseeds silently", () => {
  const { notifier, spawned } = harness();
  notifier.update([snap({ state: "permission" })]);
  notifier.reset([snap({ state: "busy" })]);
  assert.equal(spawned[0].closed, true);
  notifier.update([snap({ state: "busy" })]);
  assert.equal(spawned.length, 1, "reseeded state is not a transition");
  notifier.update([snap({ state: "idle" })]);
  assert.equal(spawned.length, 2, "a genuine edge after the reseed still toasts");
});

test("binder: gaining visibility closes every toast this tab created", () => {
  const { notifier, spawned, state } = harness();
  notifier.update([
    snap({ id: "a", state: "permission" }),
    snap({ id: "b", state: "permission", title: "web" }),
  ]);
  assert.equal(spawned.length, 2);
  state.visible = true;
  notifier.visibilityChanged();
  assert.ok(spawned.every((t) => t.closed));
});

test("binder: losing visibility re-toasts a still-pending permission (the switch-away race)", () => {
  const { notifier, spawned, state } = harness({ visible: true });
  notifier.update([snap({ state: "permission", tool: "Bash" })]); // seen, suppressed
  assert.equal(spawned.length, 0);
  state.visible = false;
  notifier.visibilityChanged();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].opts.title, "⚠ permission — mirafold");
});

test("binder: losing visibility never re-toasts idle sessions", () => {
  const { notifier, spawned, state } = harness({ visible: true });
  notifier.update([snap({ state: "idle" })]);
  state.visible = false;
  notifier.visibilityChanged();
  assert.equal(spawned.length, 0);
});

test("binder: losing visibility respects the preference and the OS grant", () => {
  const { notifier, spawned, state } = harness({ visible: true });
  notifier.update([snap({ state: "permission" })]);
  state.visible = false;
  state.enabled = false;
  notifier.visibilityChanged();
  assert.equal(spawned.length, 0);
});

test("binder: click focuses the firing tab and dismisses", () => {
  const { notifier, spawned, state } = harness();
  notifier.update([snap({ state: "permission" })]);
  spawned[0].onclick!();
  assert.equal(state.focused, 1);
  assert.equal(spawned[0].closed, true);
});

test("binder: an unsupported spawn (null) is survivable", () => {
  const state = { visible: false };
  const notifier = createNotifier({
    enabled: () => true,
    granted: () => true,
    visible: () => state.visible,
    spawn: () => null,
    focus: () => {},
  });
  notifier.update([snap({ state: "permission" })]);
  notifier.update([snap({ state: "idle" })]);
  notifier.visibilityChanged();
});
