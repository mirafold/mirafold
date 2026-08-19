// Phase RC: classify-before-create. A remote viewport creating a session
// whose credential kind is optimistic (kindPending + verifyBackendKind —
// OpenCode) waits for the truthful classification before the relay gate
// judges the attach; every failure shape errors honestly and reaps the
// no-viewport mint. Runs in its own process, so the verify timeout can be
// pinned via env before connection.ts loads its module constant.
process.env.VERIFY_KIND_TIMEOUT_MS = "120";

// Static imports would hoist above the env pin; only connection.ts reads it
// at module load, so it alone arrives dynamically.
const { openConnection } = await import("./connection");

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "./registry";
import { waitFor } from "../testing/wait-for";
import type { WireMsg } from "../protocol";
import type { AgentSession, Backend } from "../adapters";
import type { CredentialKind } from "../provider-policy";
import type { Connection } from "./connection";

const OC: Backend = { agent: "opencode", kind: "api-key", live: true };

type KindUpdate = { kind: CredentialKind; provider?: string };

/** The RC seam shape: an optimistic session whose truth arrives when the
 *  test says so, standing in for OpenCodeSession.ensureStarted(). */
class FakeClassifyingSession implements AgentSession {
  verifyCalls = 0;
  closed = false;
  private kindCb?: (u: KindUpdate) => void;
  private settle!: { resolve: () => void; reject: (err: Error) => void };
  private verifyDone: Promise<void>;

  constructor() {
    this.verifyDone = new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.verifyDone.catch(() => {}); // observed via verifyBackendKind()
  }
  publish(update: KindUpdate) {
    this.kindCb?.(update);
  }
  succeed(update: KindUpdate) {
    this.publish(update);
    this.settle.resolve();
  }
  fail(reason: string) {
    this.settle.reject(new Error(reason));
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
    this.verifyCalls++;
    return this.verifyDone;
  }
  close() {
    this.closed = true;
  }
}

function rig() {
  const sessions: FakeClassifyingSession[] = [];
  const reg = new SessionRegistry(OC, 0, undefined, undefined, () => {
    const s = new FakeClassifyingSession();
    sessions.push(s);
    return s;
  });
  return { reg, sessions };
}

function conn(reg: SessionRegistry, remote: boolean) {
  const seen: WireMsg[] = [];
  const c = openConnection(reg, (m) => seen.push(m), "test", undefined, remote);
  return { c, seen };
}
const send = (c: Connection, msg: unknown) => c.handleMessage(JSON.stringify(msg));
const of = (seen: WireMsg[], type: string) => seen.filter((m) => m.type === type);
const errors = (seen: WireMsg[]) =>
  of(seen, "error").map((m) => (m as { message: string }).message);

test("RC: a LOCAL create stays lazy — no verification, attached while pending", () => {
  const { reg, sessions } = rig();
  const { c, seen } = conn(reg, false);
  send(c, { type: "create", cwd: process.cwd() });
  assert.equal(of(seen, "session_created").length, 1, "attached immediately");
  assert.equal(sessions[0].verifyCalls, 0, "classification not forced");
  const id = (of(seen, "session_created")[0] as { sessionId: string }).sessionId;
  assert.equal(reg.get(id)?.kindPending, true, "still pending until the first turn");
  c.close();
  reg.end(id);
});

test("RC: a remote create attaches once the truthful kind lands eligible", async () => {
  const { reg, sessions } = rig();
  const { c, seen } = conn(reg, true);
  send(c, { type: "create", cwd: process.cwd() });
  assert.equal(of(seen, "session_created").length, 0, "no attach before the truth");
  await waitFor(() => sessions[0]?.verifyCalls === 1, "verification to start");
  sessions[0].succeed({ kind: "api-key", provider: "openai" });
  await waitFor(() => of(seen, "session_created").length === 1, "post-verify attach");
  const id = (of(seen, "session_created")[0] as { sessionId: string }).sessionId;
  assert.equal(reg.get(id)?.kindPending, false, "entry carries the truthful kind");
  assert.equal(errors(seen).length, 0);
  c.close();
  reg.end(id);
});

test("RC: a remote create whose truth is relay-ineligible is refused and reaped", async () => {
  const { reg, sessions } = rig();
  const { c, seen } = conn(reg, true);
  send(c, { type: "create", cwd: process.cwd() });
  await waitFor(() => sessions[0]?.verifyCalls === 1, "verification to start");
  sessions[0].succeed({ kind: "gateway", provider: "opencode" });
  await waitFor(() => of(seen, "refused").length === 1, "the relay gate's refusal");
  assert.equal(of(seen, "session_created").length, 0, "never attached");
  await waitFor(() => sessions[0].closed, "the mint reaped");
  c.close();
});

test("RC: a classify failure errors the creator honestly and reaps", async () => {
  const { reg, sessions } = rig();
  const { c, seen } = conn(reg, true);
  send(c, { type: "create", cwd: process.cwd() });
  await waitFor(() => sessions[0]?.verifyCalls === 1, "verification to start");
  sessions[0].fail("no model is pinned for this OpenCode session");
  await waitFor(() => errors(seen).length === 1, "the honest error");
  assert.ok(errors(seen)[0].includes("no model is pinned"));
  assert.equal(of(seen, "session_created").length, 0);
  await waitFor(() => sessions[0].closed, "the mint reaped");
  c.close();
});

test("RC: a verification that never settles times out bounded and reaps", async () => {
  const { reg, sessions } = rig();
  const { c, seen } = conn(reg, true);
  send(c, { type: "create", cwd: process.cwd() });
  await waitFor(() => errors(seen).length === 1, "the timeout refusal", 5_000);
  assert.ok(errors(seen)[0].includes("took too long"));
  await waitFor(() => sessions[0].closed, "the mint reaped");
  c.close();
});

test("RC: the creator disconnecting mid-classify leaks nothing", async () => {
  const { reg, sessions } = rig();
  const { c, seen } = conn(reg, true);
  send(c, { type: "create", cwd: process.cwd() });
  await waitFor(() => sessions[0]?.verifyCalls === 1, "verification to start");
  c.close();
  sessions[0].succeed({ kind: "api-key", provider: "openai" });
  await waitFor(() => sessions[0].closed, "the ownerless mint reaped");
  assert.equal(of(seen, "session_created").length, 0, "nothing sent to a dead viewport");
});

test("RC: a second create mid-verify is refused; the connection recovers after settle", async () => {
  const { reg, sessions } = rig();
  const { c, seen } = conn(reg, true);
  send(c, { type: "create", cwd: process.cwd() });
  await waitFor(() => sessions[0]?.verifyCalls === 1, "verification to start");
  send(c, { type: "create", cwd: process.cwd() });
  assert.ok(errors(seen).some((m) => m.includes("still verifying")));
  assert.equal(sessions.length, 1, "no second mint while one is in flight");
  sessions[0].succeed({ kind: "api-key", provider: "openai" });
  await waitFor(() => of(seen, "session_created").length === 1, "the first create lands");
  const id = (of(seen, "session_created")[0] as { sessionId: string }).sessionId;
  c.close();
  reg.end(id);
});
