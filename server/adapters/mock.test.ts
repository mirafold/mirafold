import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../protocol";
import { MockSession } from "./mock";

// 2026-07-29 bughunt: interrupt()/close() cleared pending asks WITHOUT the
// permission_resolved the protocol contract requires on every resolution
// path (protocol.ts) — a second viewport kept a dead bar and the replay
// buffer held an unresolved ask forever. The real adapter's teardown deny
// (denyAllPending) always announced; the mock now does too.

type Any = WireMsg & Record<string, unknown>;

const waitFor = (msgs: Any[], pred: (m: Any) => boolean, label: string, timeoutMs = 10_000) =>
  new Promise<Any>((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const hit = msgs.find(pred);
      if (hit) {
        clearInterval(poll);
        resolve(hit);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`no ${label}; seen: ${msgs.map((m) => m.type).join(",")}`));
      }
    }, 5);
  });

test("an interrupted pending ask resolves as a deny — never silently dropped", async () => {
  const s = new MockSession();
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  s.pushPrompt("please run rm -rf on the cache");
  const ask = await waitFor(msgs, (m) => m.type === "permission_request", "permission_request");
  s.interrupt();
  const resolved = await waitFor(
    msgs,
    (m) => m.type === "permission_resolved" && m.id === ask.id,
    "permission_resolved",
  );
  assert.equal(resolved.allow, false);
  s.close();
});

test("close() with a pending ask announces the deny too", async () => {
  const s = new MockSession();
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  s.pushPrompt("sudo something dangerous");
  const ask = await waitFor(msgs, (m) => m.type === "permission_request", "permission_request");
  s.close();
  assert.ok(
    msgs.some((m) => m.type === "permission_resolved" && m.id === ask.id && m.allow === false),
    "the teardown deny is announced",
  );
});

test("a CR.3 Request change draft deterministically returns both highlighted markdown fences", async () => {
  const s = new MockSession();
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  s.pushPrompt('Please revise the selected workspace change.\n\nFile: "src/review.ts"');
  await waitFor(msgs, (m) => m.type === "turn_end", "turn_end");
  const text = msgs
    .filter((m) => m.type === "text_delta")
    .map((m) => String(m.text))
    .join("");
  assert.match(text, /```diff/);
  assert.match(text, /```ts/);
  s.close();
});
