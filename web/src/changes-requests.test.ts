import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangeItem } from "./changes";
import { CHANGE_FILE_REQUEST_GAP_MS, CHANGE_REFRESH_GAP_MS, createChangesRequests } from "./changes-requests";

// Only `path` and `status` reach the object under test.
const item = (path: string): ChangeItem =>
  ({ path, status: "M", repoRoot: "", displayPath: path }) as unknown as ChangeItem;

function harness() {
  let t = 100_000; // a real clock is never near zero; delay math treats "never requested" as long ago
  let nextTimer = 1;
  const scheduled = new Map<number, { at: number; fn: () => void }>();
  const sent: string[] = [];
  const opened: string[] = [];
  const r = createChangesRequests({
    requestChanges: () => {
      const id = `req-${sent.length + 1}`;
      sent.push(id);
      return id;
    },
    openFile: (i) => opened.push(i.path),
    now: () => t,
    timers: {
      set: (fn, ms) => {
        const id = nextTimer++;
        scheduled.set(id, { at: t + ms, fn });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clear: (id) => {
        scheduled.delete(id as unknown as number);
      },
    },
  });
  const tick = (ms: number) => {
    t += ms;
    for (const [id, { at, fn }] of [...scheduled]) {
      if (at <= t) {
        scheduled.delete(id);
        fn();
      }
    }
  };
  r.setOpen(true);
  r.setSession("s1");
  return { r, sent, opened, tick, timersPending: () => scheduled.size };
}

test("one request in flight; a refresh asked meanwhile runs after the reply", () => {
  const { r, sent, tick } = harness();
  assert.equal(r.requestNow(), true);
  assert.equal(r.requestNow(), false, "queued behind the in-flight one");
  assert.equal(r.acceptReply("stale"), false);
  assert.equal(r.acceptReply("req-1"), true);
  r.afterReply();
  tick(CHANGE_REFRESH_GAP_MS);
  assert.deepEqual(sent, ["req-1", "req-2"]);
});

test("bells coalesce onto one refresh outside the daemon's rate window", () => {
  const { r, sent, tick } = harness();
  r.requestNow();
  r.acceptReply("req-1");
  r.scheduleRefresh();
  r.scheduleRefresh();
  r.scheduleRefresh();
  tick(CHANGE_REFRESH_GAP_MS - 1);
  assert.equal(sent.length, 1, "inside the gap nothing fires");
  tick(1);
  assert.deepEqual(sent, ["req-1", "req-2"]);
});

test("rapid file navigation lands on the newest ask; the first inside the gap waits", () => {
  const { r, opened, tick } = harness();
  r.queueFile(item("a.ts"));
  assert.deepEqual(opened, ["a.ts"], "nothing recent — opens immediately");
  r.queueFile(item("b.ts"));
  r.queueFile(item("c.ts"));
  assert.deepEqual(opened, ["a.ts"]);
  tick(CHANGE_FILE_REQUEST_GAP_MS);
  assert.deepEqual(opened, ["a.ts", "c.ts"]);
});

test("closed or session-less surfaces request nothing; reset drops scheduled work", () => {
  const { r, sent, opened, tick, timersPending } = harness();
  r.setOpen(false);
  r.scheduleRefresh();
  assert.equal(timersPending(), 0);
  r.setOpen(true);
  r.setSession(undefined);
  assert.equal(r.requestNow(), false);
  r.setSession("s1");
  r.requestNow();
  r.acceptReply("req-1");
  r.scheduleRefresh();
  r.queueFile(item("x.ts"));
  r.queueFile(item("y.ts"));
  r.reset();
  tick(10_000);
  assert.deepEqual(sent, ["req-1"]);
  assert.deepEqual(opened, ["x.ts"]);
});
