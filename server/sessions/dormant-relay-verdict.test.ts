import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Backend } from "../adapters";
import type { CredentialKind } from "../provider-policy";
import type { WireMsg } from "../protocol";
import { openConnection, type Connection } from "./connection";
import { SessionRegistry } from "./registry";
import { SessionCheckpointStore, type StoredSession } from "./session-store";

// Audit 2026-08-30 (+ PR #77 review): a session whose credential kind is a
// hello-time GUESS (OpenCode) refuses every remote act while active, but its
// idle-unloaded checkpoint used to answer the cockpit-tail relay verdict from
// the stored kind — so the dormant row sent text over the relay while a
// remote attach to the same record was refused. Revival always re-classifies
// such an agent, so its dormant record holds no current verdict at all: the
// tail is pending until the session is warm and classified. These tests pin
// ONE verdict per record — active, dormant, or restored from disk — through
// the real remote connection, and that agents whose kind was truthful at
// create are not over-blocked.

type KindUpdate = { kind: CredentialKind; provider?: string };
const OPTIMISTIC: Backend = { agent: "opencode", kind: "api-key", live: true };

/** A classifying session: kind stays pending until the test publishes it. */
class ClassifyingSession {
  private kindCb?: (u: KindUpdate) => void;
  publish(update: KindUpdate) {
    this.kindCb?.(update);
  }
  pushPrompt() {}
  onMessage() {}
  interrupt() {}
  resolvePermission() {}
  get modelName(): string | undefined {
    return undefined;
  }
  onBackendKind(cb: (u: KindUpdate) => void) {
    this.kindCb = cb;
  }
  verifyBackendKind(): Promise<void> {
    return new Promise(() => {});
  }
  close() {}
}

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const send = (c: Connection, msg: unknown) => c.handleMessage(JSON.stringify(msg));
const waitUntil = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(done(), "condition reached");
};

function rig(store = new SessionCheckpointStore(tmp("mf-verdict-store-"))) {
  const sessions: ClassifyingSession[] = [];
  const reg = new SessionRegistry({
    backend: OPTIMISTIC,
    deltaCoalesceMs: 0,
    store,
    idleTimeoutMs: 10,
    makeSession: () => {
      const s = new ClassifyingSession();
      sessions.push(s);
      return s as never;
    },
  });
  return { reg, sessions, store };
}

const tailFor = (reg: SessionRegistry, id: string, remote: boolean) =>
  reg.summary({ transcript: true, remote }).find((row) => row.sessionId === id)?.transcriptTail?.text;

const remoteWatchTail = (reg: SessionRegistry, id: string) => {
  const seen: WireMsg[] = [];
  const c = openConnection(reg, (m) => seen.push(m), { label: "test", remote: true });
  send(c, { type: "watch_sessions", transcript: true });
  c.close();
  const snapshot = seen.find((m): m is Extract<WireMsg, { type: "sessions" }> => m.type === "sessions");
  return snapshot?.sessions.find((row) => row.sessionId === id)?.transcriptTail?.text;
};

async function unload(reg: SessionRegistry, id: string) {
  reg.releaseIfUnviewed(reg.get(id)!);
  await waitUntil(() => reg.get(id) === undefined);
}

test("a pending-kind session gives a remote cockpit no tail — active, dormant, and restored from disk alike", async () => {
  const { reg, store } = rig();
  const e = reg.create({ cwd: tmp("mf-verdict-root-") });
  assert.equal(e.kindPending, true);
  reg.broadcast(e, { type: "text_delta", text: "unverified transcript" });

  assert.equal(tailFor(reg, e.id, false), "unverified transcript", "the local cockpit sees it");
  assert.equal(tailFor(reg, e.id, true), undefined, "active: refused over the relay");

  await unload(reg, e.id);
  assert.equal(tailFor(reg, e.id, false), "unverified transcript", "dormant: local still sees it");
  assert.equal(tailFor(reg, e.id, true), undefined, "dormant: still refused over the relay");
  assert.equal(remoteWatchTail(reg, e.id), undefined, "…through the real remote connection too");

  const { reg: restarted } = rig(store);
  assert.equal(restarted.get(e.id), undefined, "restored dormant, not warm");
  assert.equal(tailFor(restarted, e.id, false), "unverified transcript");
  assert.equal(tailFor(restarted, e.id, true), undefined, "restart: still refused over the relay");
  assert.equal(remoteWatchTail(restarted, e.id), undefined);
  assert.equal(restarted.end(e.id), true);
});

test("a classifying agent's verified kind is a WARM verdict only: api-key sends while active, nothing sends once dormant", async () => {
  for (const [kind, activeExpected] of [
    ["api-key", "api-key transcript"],
    ["subscription", undefined],
  ] as const) {
    const { reg, sessions, store } = rig();
    const e = reg.create({ cwd: tmp("mf-verdict-root-") });
    reg.broadcast(e, { type: "text_delta", text: `${kind} transcript` });
    sessions[0].publish({ kind });
    assert.equal(e.kindPending, false);
    assert.equal(tailFor(reg, e.id, true), activeExpected, `active ${kind}`);

    await unload(reg, e.id);
    assert.equal(tailFor(reg, e.id, false), `${kind} transcript`, `dormant ${kind}: local still sees it`);
    assert.equal(tailFor(reg, e.id, true), undefined, `dormant ${kind}: revival re-classifies, so no current verdict`);
    assert.equal(remoteWatchTail(reg, e.id), undefined, `dormant ${kind} over the real connection`);

    const { reg: restarted } = rig(store);
    assert.equal(tailFor(restarted, e.id, true), undefined, `restored ${kind}`);
    assert.equal(restarted.end(e.id), true);
  }
});

function record(id: string, backend: Backend, text: string): StoredSession {
  const root = tmp("mf-verdict-root-");
  return {
    version: 1,
    id,
    cwd: root,
    bangCwd: root,
    backend,
    promptOptions: [],
    buffer: [{ type: "text_delta", text, seq: 1 } as never],
    nextSeq: 2,
    name: id,
    status: "idle",
    lastActivity: 20,
    createdAt: 10,
  };
}

test("agents whose kind was truthful at create keep the record's own verdict; the mock stand-in is never gated", () => {
  const store = new SessionCheckpointStore(tmp("mf-verdict-store-"));
  store.write(record("liveoc", { agent: "opencode", kind: "api-key", live: true }, "live opencode text"));
  store.write(record("mockoc", { agent: "opencode", kind: "none", live: false }, "mock opencode text"));
  store.write(record("cc-api", { agent: "claude-code", kind: "api-key", live: true }, "claude api text"));
  store.write(record("cc-sub", { agent: "claude-code", kind: "subscription", live: true }, "claude sub text"));
  const { reg } = rig(store);
  for (const id of ["liveoc", "mockoc", "cc-api", "cc-sub"]) assert.equal(reg.get(id), undefined, `${id} loaded dormant`);

  assert.equal(tailFor(reg, "liveoc", false), "live opencode text", "local cockpit sees it");
  assert.equal(tailFor(reg, "liveoc", true), undefined, "a live classifying record: pending until revived");
  assert.equal(remoteWatchTail(reg, "liveoc"), undefined);
  assert.equal(tailFor(reg, "mockoc", true), "mock opencode text", "the API-free MockSession never classifies");
  assert.equal(tailFor(reg, "cc-api", true), "claude api text", "a truthful api-key record is not over-blocked");
  assert.equal(tailFor(reg, "cc-sub", true), undefined, "a truthful subscription record is refused as its kind says");
  for (const id of ["liveoc", "mockoc", "cc-api", "cc-sub"]) assert.equal(reg.end(id), true);
});
