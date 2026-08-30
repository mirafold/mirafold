import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Backend } from "../adapters";
import type { CredentialKind } from "../provider-policy";

type KindUpdate = { kind: CredentialKind; provider?: string };
import type { WireMsg } from "../protocol";
import { openConnection, type Connection } from "./connection";
import { SessionRegistry } from "./registry";
import { SessionCheckpointStore, type StoredSession } from "./session-store";

// Audit 2026-08-30: a session whose credential kind is still a hello-time
// GUESS (OpenCode before its first turn) refuses every remote act while it is
// active, but its idle-unloaded checkpoint used to record the guess as fact —
// so the relay verdict a dormant row gave the cockpit tail contradicted the
// verdict the same record gave a remote attach. These tests pin ONE verdict
// per record, active or dormant, in memory or restored from disk.

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
const onDisk = (store: SessionCheckpointStore, id: string) => store.loadAll().sessions.get(id);
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
  const entry = reg.get(id)!;
  reg.releaseIfUnviewed(entry);
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

  // A daemon restart reads the record back from disk: the fact survives.
  const { reg: restarted } = rig(store);
  assert.equal(restarted.get(e.id), undefined, "restored dormant, not warm");
  assert.equal(tailFor(restarted, e.id, false), "unverified transcript");
  assert.equal(tailFor(restarted, e.id, true), undefined, "restart: still refused over the relay");
  assert.equal(remoteWatchTail(restarted, e.id), undefined);
  assert.equal(restarted.end(e.id), true);
});

test("once the kind is verified, the dormant verdict is the kind's own: api-key sends, subscription refuses", async () => {
  for (const [kind, expected] of [
    ["api-key", `${"api-key"} transcript`],
    ["subscription", undefined],
  ] as const) {
    const { reg, sessions, store } = rig();
    const e = reg.create({ cwd: tmp("mf-verdict-root-") });
    reg.broadcast(e, { type: "text_delta", text: `${kind} transcript` });
    sessions[0].publish({ kind });
    assert.equal(e.kindPending, false);
    assert.equal(tailFor(reg, e.id, true), expected, `active ${kind}`);

    await unload(reg, e.id);
    assert.equal(tailFor(reg, e.id, true), expected, `dormant ${kind}`);
    assert.equal(remoteWatchTail(reg, e.id), expected, `dormant ${kind} over the real connection`);

    const { reg: restarted } = rig(store);
    assert.equal(tailFor(restarted, e.id, true), expected, `restored ${kind}`);
    assert.equal(onDisk(store, e.id)?.kindPending, false, "a verified classifying record says so explicitly");
    assert.equal(restarted.end(e.id), true);
  }
});

test("the checkpoint records the pending fact and clears it when the kind is published", () => {
  const { reg, sessions, store } = rig();
  const e = reg.create({ cwd: tmp("mf-verdict-root-") });
  assert.equal(onDisk(store, e.id)?.kindPending, true, "written at create, while pending");
  sessions[0].publish({ kind: "api-key" });
  assert.equal(onDisk(store, e.id)?.kindPending, false, "cleared by the verdict's own checkpoint");
  reg.end(e.id);
});

// Records written before the flag existed (any daemon ≤ 0.6.1) carry none.
// For an agent that classifies at engine start that record may hold the
// hello-time guess, so it reads as unverified until rewritten; an agent whose
// kind was truthful at create reads as its kind says.
function legacyRecord(id: string, backend: Backend, text: string): StoredSession {
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

test("a flagless (pre-2026-08-30) record of a classifying agent reads as unverified; a non-classifying one reads as its kind", () => {
  const store = new SessionCheckpointStore(tmp("mf-verdict-store-"));
  const opencode = legacyRecord("legacyoc", { agent: "opencode", kind: "api-key", live: true }, "legacy opencode text");
  const claude = legacyRecord("legacycc", { agent: "claude-code", kind: "api-key", live: false }, "legacy claude text");
  store.write(opencode);
  store.write(claude);
  const { reg } = rig(store);
  assert.equal(reg.get("legacyoc"), undefined, "loaded dormant");
  assert.equal(tailFor(reg, "legacyoc", false), "legacy opencode text", "local cockpit still sees it");
  assert.equal(tailFor(reg, "legacyoc", true), undefined, "remote: fail-closed until rewritten");
  assert.equal(remoteWatchTail(reg, "legacyoc"), undefined);
  assert.equal(tailFor(reg, "legacycc", true), "legacy claude text", "a truthful api-key record is not over-blocked");
  assert.equal(reg.end("legacyoc"), true);
  assert.equal(reg.end("legacycc"), true);
});

test("opening a flagless classifying record rewrites it explicitly: pending on revive, verified after the kind publishes", async () => {
  const store = new SessionCheckpointStore(tmp("mf-verdict-store-"));
  store.write(legacyRecord("legacyoc2", { agent: "opencode", kind: "api-key", live: true }, "legacy opencode text"));
  const { reg, sessions } = rig(store);
  const revived = reg.open("legacyoc2")!;
  assert.equal(revived.kindPending, true);
  assert.equal(onDisk(store, "legacyoc2")?.kindPending, true, "the revive checkpoint says pending explicitly");
  sessions[0].publish({ kind: "api-key" });
  assert.equal(onDisk(store, "legacyoc2")?.kindPending, false);
  await unload(reg, "legacyoc2");
  assert.equal(tailFor(reg, "legacyoc2", true), "legacy opencode text", "verified: the remote cockpit gets it");
  assert.equal(reg.end("legacyoc2"), true);
});
