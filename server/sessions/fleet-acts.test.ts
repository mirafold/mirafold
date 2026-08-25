import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WireMsg } from "../protocol";
import { SessionRegistry } from "./registry";
import { openConnection, type Connection } from "./connection";
import type { Backend } from "../adapters";

// M.2: the cockpit acts' input validation and the R.4i relay gate, in-process
// (openConnection driven directly, `remote` flag in hand — the one axis the
// Tier-2 socket harness can't reach without a full relay rig). The real
// over-the-socket round-trips live in fleet-cockpit.itest.ts.

const dir = () => mkdtempSync(path.join(os.tmpdir(), "genui-fleet-"));
// live:false → the inert MockSession; `kind` is what the gate reads.
const SUB: Backend = { agent: "codex", kind: "subscription", live: false };
const NONE: Backend = { agent: "claude-code", kind: "none", live: false };

function conn(reg: SessionRegistry, remote: boolean) {
  const seen: WireMsg[] = [];
  const c = openConnection(reg, (m) => seen.push(m), { label: "test", remote });
  return { c, seen };
}
const send = (c: Connection, msg: unknown) => c.handleMessage(JSON.stringify(msg));
const errors = (seen: WireMsg[]) =>
  seen.filter((m) => m.type === "error").map((m) => (m as { message: string }).message);

test("M.2 remote gate: prompt_session and answer_permission are refused on a subscription session", () => {
  const reg = new SessionRegistry({ backend: SUB });
  const e = reg.create({ cwd: dir() });
  const { c, seen } = conn(reg, true);

  send(c, { type: "prompt_session", sessionId: e.id, text: "hi" });
  send(c, { type: "answer_permission", sessionId: e.id, id: "p1", allow: true });

  assert.equal(errors(seen).length, 2);
  assert.ok(errors(seen).every((m) => m.includes("subscription")));
  assert.ok(
    !e.ring.buffer.some((m) => m.type === "user_prompt"),
    "the refused prompt never reached the session stream",
  );
  reg.end(e.id);
});

test("M.2 remote gate: a DENY is not gated — stopping the model is not driving it", () => {
  // Gating both paths left a phone watching a subscription session unable to
  // deny a pending ask at all; only PERMISSION_TIMEOUT_MS resolved it
  // (2026-07-28 fix). protocol.ts scopes the gate to the ALLOW path.
  const reg = new SessionRegistry({ backend: SUB });
  const e = reg.create({ cwd: dir() });
  reg.broadcast(e, { type: "permission_request", tool: "Bash", detail: "a", id: "p1" });
  const { c, seen } = conn(reg, true);
  send(c, { type: "answer_permission", sessionId: e.id, id: "p1", allow: false });
  assert.equal(errors(seen).length, 0, "the deny is not refused");
  assert.deepEqual(e.permissions, [], "the ask leaves the pending queue");
  reg.end(e.id);
});

test("M.2 remote gate: interrupt_session stays ungated (teardown, like end_session)", () => {
  const reg = new SessionRegistry({ backend: SUB });
  const e = reg.create({ cwd: dir() });
  const { c, seen } = conn(reg, true);
  send(c, { type: "interrupt_session", sessionId: e.id });
  assert.equal(errors(seen).length, 0);
  reg.end(e.id);
});

test("M.2 local connections are never gated — a subscription session takes a grid prompt", () => {
  const reg = new SessionRegistry({ backend: SUB });
  const e = reg.create({ cwd: dir() });
  const { c, seen } = conn(reg, false);
  send(c, { type: "prompt_session", sessionId: e.id, text: "hi" });
  assert.equal(errors(seen).length, 0);
  assert.ok(e.ring.buffer.some((m) => m.type === "user_prompt"));
  reg.end(e.id);
});

// AUDIT 2026-08-13 (exploitable): OpenCode is the first adapter whose
// credential KIND can change mid-session (a `/model` switch to a ChatGPT or
// Zen provider). The attach-time relay gate is not enough — the drive-time
// paths must re-check, and an attached remote viewport must be evicted.

test("AUDIT: a mid-session flip to subscription refuses the remote viewport's own prompt/action", () => {
  // The session attaches relay-eligible (api-key), then flips.
  const reg = new SessionRegistry({ backend: { agent: "opencode", kind: "api-key", live: false } });
  const e = reg.create({ cwd: dir() });
  const { c, seen } = conn(reg, true);
  send(c, { type: "attach", sessionId: e.id });
  // The flip's registry-side effect (what onBackendKind sets).
  e.kind = "subscription";

  send(c, { type: "prompt", text: "drive the subscription" });
  send(c, { type: "action", action: { kind: "prompt", text: "drive it again" }, sourceId: "x" });

  assert.equal(errors(seen).filter((m) => m.includes("subscription")).length, 2);
  assert.ok(
    !e.ring.buffer.some((m) => m.type === "user_prompt"),
    "neither drive path reached the subscription session over the relay",
  );
  reg.end(e.id);
});

test("AUDIT: a local tab's prompt on the same flipped session is NOT gated", () => {
  const reg = new SessionRegistry({ backend: { agent: "opencode", kind: "api-key", live: false } });
  const e = reg.create({ cwd: dir() });
  const { c, seen } = conn(reg, false); // local
  send(c, { type: "attach", sessionId: e.id });
  e.kind = "subscription";
  send(c, { type: "prompt", text: "local subscription use is the disclosed gray area" });
  assert.equal(errors(seen).length, 0);
  assert.ok(e.ring.buffer.some((m) => m.type === "user_prompt"));
  reg.end(e.id);
});

test("AUDIT: evictRemoteViewports drops relay viewers, spares local ones, on an ineligible flip", () => {
  const reg = new SessionRegistry({ backend: { agent: "opencode", kind: "api-key", live: false } });
  const e = reg.create({ cwd: dir() });
  const remoteSeen: WireMsg[] = [];
  const localSeen: WireMsg[] = [];
  const remoteVp = (m: WireMsg) => remoteSeen.push(m);
  const localVp = (m: WireMsg) => localSeen.push(m);
  reg.attach(e, remoteVp);
  reg.markRemote(e, remoteVp);
  reg.attach(e, localVp);
  assert.equal(e.remoteViewports.size, 1);

  e.kind = "subscription";
  (reg as unknown as { evictRemoteViewports(entry: typeof e): void }).evictRemoteViewports(e);

  assert.ok(
    remoteSeen.some((m) => m.type === "refused" && m.reason === "subscription-relay"),
    "the relay viewer is told why",
  );
  assert.ok(!e.viewports.has(remoteVp), "the relay viewer is detached");
  assert.ok(e.viewports.has(localVp), "the local viewer stays");
  assert.equal(e.remoteViewports.size, 0);
  reg.end(e.id);
});

test("M.2 unknown session ids answer with an error; malformed acts are silently ignored", () => {
  const reg = new SessionRegistry({ backend: NONE });
  const { c, seen } = conn(reg, false);
  send(c, { type: "prompt_session", sessionId: "nope", text: "x" });
  send(c, { type: "interrupt_session", sessionId: "nope" });
  send(c, { type: "answer_permission", sessionId: "nope", id: "p", allow: false });
  assert.equal(errors(seen).length, 3);
  assert.ok(errors(seen).every((m) => m.includes("no such session")));

  // Malformed fields: the repo's malformed-input convention — ignored, no
  // crash, no error spam (same posture as rename/permission_response).
  const before = seen.length;
  send(c, { type: "prompt_session", sessionId: 5, text: 7 });
  send(c, { type: "prompt_session" });
  send(c, { type: "answer_permission", sessionId: "x" });
  send(c, { type: "interrupt_session" });
  assert.equal(seen.length, before, "nothing emitted for malformed acts");
});

test("M.2 an empty or whitespace grid prompt is ignored, like the in-session prompt path", () => {
  const reg = new SessionRegistry({ backend: NONE });
  const e = reg.create({ cwd: dir() });
  const { c, seen } = conn(reg, false);
  send(c, { type: "prompt_session", sessionId: e.id, text: "   \n " });
  assert.equal(errors(seen).length, 0);
  assert.ok(!e.ring.buffer.some((m) => m.type === "user_prompt"));
  reg.end(e.id);
});

test("M.2 answer_permission drops ONLY the answered id from the queue, immediately", () => {
  const reg = new SessionRegistry({ backend: NONE });
  const e = reg.create({ cwd: dir() });
  reg.broadcast(e, { type: "permission_request", tool: "Bash", detail: "a", id: "p1" });
  reg.broadcast(e, { type: "permission_request", tool: "Write", detail: "b", id: "p2" });
  const { c } = conn(reg, false);
  send(c, { type: "answer_permission", sessionId: e.id, id: "p1", allow: true });
  assert.deepEqual(
    e.permissions.map((p) => p.id),
    ["p2"],
    "the concurrently pending request stays visible",
  );
  reg.end(e.id);
});

// 2026-07-29 bughunt: a remote CREATE refused by the relay gate minted a
// session no one was attached to — and nothing arms the idle timer before a
// first attach/detach cycle, so the entry (engine included) was immortal.
// 100 phone retries exhausted MAX_SESSIONS and locked LOCAL creates out
// until a daemon restart.

test("a relay-refused CREATE reaps the just-minted session — no leak", () => {
  const reg = new SessionRegistry({ backend: SUB });
  const { c, seen } = conn(reg, true);
  for (let i = 0; i < 5; i++) send(c, { type: "create", cwd: dir() });
  assert.equal(seen.filter((m) => m.type === "refused").length, 5);
  assert.equal(reg.summary().length, 0, "nothing immortal left in the registry");
});

test("a relay-refused ATTACH reaps only a fallback-created session, never an existing one", () => {
  const reg = new SessionRegistry({ backend: SUB });
  const local = reg.create({ cwd: dir() });
  const { c, seen } = conn(reg, true);
  // Attaching to the local tab's live session: refused, session untouched —
  // the R.4l item-5 decision (the device sees the R.4i notice) stands.
  send(c, { type: "attach", sessionId: local.id });
  assert.equal(seen.filter((m) => m.type === "refused").length, 1);
  assert.ok(reg.get(local.id), "the local tab's session survives the refusal");
  // A stale id's fallback create is this connection's own mint — reaped.
  send(c, { type: "attach", sessionId: "gone-session-id" });
  assert.equal(seen.filter((m) => m.type === "refused").length, 2);
  assert.equal(reg.summary().length, 1, "only the pre-existing session remains");
  reg.end(local.id);
});

// 2026-07-29 bughunt: the bang burst-throttle's refusal used to BROADCAST a
// fabricated bang_end — the registry read it as a terminal event (idle,
// burst gate re-opened, permission mirror wiped) and every other viewport
// got a bang_end for an id it never saw a bang_start for.

test("a throttle-refused bang answers the issuer only — nothing enters the session stream", () => {
  const reg = new SessionRegistry({ backend: NONE });
  const e = reg.create({ cwd: dir() });
  const issuer = conn(reg, false);
  const watcher = conn(reg, false);
  send(issuer.c, { type: "attach", sessionId: e.id });
  send(watcher.c, { type: "attach", sessionId: e.id });
  const watcherMark = watcher.seen.length;
  reg.broadcast(e, { type: "status", state: "thinking" }); // a model turn is live
  e.lastBangAt = Date.now(); // a bang just finished — inside the 400 ms window
  send(issuer.c, { type: "bang", command: "true", id: "b2" });
  assert.ok(
    issuer.seen.some((m) => m.type === "bang_end" && (m as { id?: string }).id === "b2"),
    "the issuer's locally-armed bar clears",
  );
  assert.ok(
    !watcher.seen.slice(watcherMark).some((m) => m.type === "bang_end"),
    "no fabricated bang_end reaches other viewports",
  );
  assert.ok(!e.ring.buffer.some((m) => m.type === "bang_end"), "the replay ring stays clean");
  assert.equal(e.status, "working", "a mid-turn session never flips idle over a refused bang");
  reg.end(e.id);
});
