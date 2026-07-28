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
  const c = openConnection(reg, (m) => seen.push(m), "test", undefined, remote);
  return { c, seen };
}
const send = (c: Connection, msg: unknown) => c.handleMessage(JSON.stringify(msg));
const errors = (seen: WireMsg[]) =>
  seen.filter((m) => m.type === "error").map((m) => (m as { message: string }).message);

test("M.2 remote gate: prompt_session and answer_permission are refused on a subscription session", () => {
  const reg = new SessionRegistry(SUB);
  const e = reg.create({ cwd: dir() });
  const { c, seen } = conn(reg, true);

  send(c, { type: "prompt_session", sessionId: e.id, text: "hi" });
  send(c, { type: "answer_permission", sessionId: e.id, id: "p1", allow: true });

  assert.equal(errors(seen).length, 2);
  assert.ok(errors(seen).every((m) => m.includes("subscription")));
  assert.ok(
    !e.buffer.some((m) => m.type === "user_prompt"),
    "the refused prompt never reached the session stream",
  );
  reg.end(e.id);
});

test("M.2 remote gate: a DENY is not gated — stopping the model is not driving it", () => {
  // Gating both paths left a phone watching a subscription session unable to
  // deny a pending ask at all; only PERMISSION_TIMEOUT_MS resolved it
  // (2026-07-28 fix). protocol.ts scopes the gate to the ALLOW path.
  const reg = new SessionRegistry(SUB);
  const e = reg.create({ cwd: dir() });
  reg.broadcast(e, { type: "permission_request", tool: "Bash", detail: "a", id: "p1" });
  const { c, seen } = conn(reg, true);
  send(c, { type: "answer_permission", sessionId: e.id, id: "p1", allow: false });
  assert.equal(errors(seen).length, 0, "the deny is not refused");
  assert.deepEqual(e.permissions, [], "the ask leaves the pending queue");
  reg.end(e.id);
});

test("M.2 remote gate: interrupt_session stays ungated (teardown, like end_session)", () => {
  const reg = new SessionRegistry(SUB);
  const e = reg.create({ cwd: dir() });
  const { c, seen } = conn(reg, true);
  send(c, { type: "interrupt_session", sessionId: e.id });
  assert.equal(errors(seen).length, 0);
  reg.end(e.id);
});

test("M.2 local connections are never gated — a subscription session takes a grid prompt", () => {
  const reg = new SessionRegistry(SUB);
  const e = reg.create({ cwd: dir() });
  const { c, seen } = conn(reg, false);
  send(c, { type: "prompt_session", sessionId: e.id, text: "hi" });
  assert.equal(errors(seen).length, 0);
  assert.ok(e.buffer.some((m) => m.type === "user_prompt"));
  reg.end(e.id);
});

test("M.2 unknown session ids answer with an error; malformed acts are silently ignored", () => {
  const reg = new SessionRegistry(NONE);
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
  const reg = new SessionRegistry(NONE);
  const e = reg.create({ cwd: dir() });
  const { c, seen } = conn(reg, false);
  send(c, { type: "prompt_session", sessionId: e.id, text: "   \n " });
  assert.equal(errors(seen).length, 0);
  assert.ok(!e.buffer.some((m) => m.type === "user_prompt"));
  reg.end(e.id);
});

test("M.2 answer_permission drops ONLY the answered id from the queue, immediately", () => {
  const reg = new SessionRegistry(NONE);
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
