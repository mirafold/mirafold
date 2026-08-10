import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Backend } from "../adapters";
import { SessionRegistry } from "./registry";
import { SessionCheckpointStore, type StoredSession } from "./session-store";
import type { WireMsg } from "../protocol";

const MOCK_BACKEND: Backend = { agent: "codex", kind: "none", live: false };

function fixture(id = "deadbeef"): StoredSession {
  return {
    version: 1,
    id,
    cwd: "/tmp",
    bangCwd: "/tmp",
    backend: MOCK_BACKEND,
    promptOptions: [
      { trigger: "$", value: "$next", label: "next", kind: "skill" },
    ],
    buffer: [
      { type: "user_prompt", text: "hello", seq: 1 },
      { type: "text_delta", text: "hi", seq: 2 },
      { type: "turn_end", seq: 3 },
    ],
    nextSeq: 4,
    name: "saved work",
    status: "idle",
    lastActivity: 20,
    createdAt: 10,
  };
}

test("checkpoint store writes one owner-only atomic record and round-trips it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  const store = new SessionCheckpointStore(dir);
  const stored = fixture();
  store.write(stored);

  assert.deepEqual(readdirSync(dir), [`${stored.id}.json`], "no temp file survives the rename");
  assert.deepEqual(store.loadAll().sessions.get(stored.id), stored);
  assert.equal(store.loadAll().errors.size, 0);
  if (process.platform !== "win32") {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(dir, `${stored.id}.json`)).mode & 0o777, 0o600);
  }
});

test("a corrupt checkpoint is retained and reported, never silently treated as a gone session", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  writeFileSync(path.join(dir, "badc0ffe.json"), "{broken", { mode: 0o600 });
  const store = new SessionCheckpointStore(dir);
  const loaded = store.loadAll();
  assert.equal(loaded.sessions.size, 0);
  assert.match(loaded.errors.get("badc0ffe") ?? "", /JSON/);
  assert.equal(readFileSync(path.join(dir, "badc0ffe.json"), "utf8"), "{broken");

  const registry = new SessionRegistry(MOCK_BACKEND, 0, store);
  assert.throws(() => registry.open("badc0ffe"), /saved but its checkpoint is unavailable/);
  assert.equal(registry.end("badc0ffe"), true, "explicit end is the deletion path");
  assert.equal(readdirSync(dir).length, 0);
});

test("a new registry lists and lazily reopens the exact saved transcript", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-root-"));
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  const store = new SessionCheckpointStore(storeDir);
  const first = new SessionRegistry(MOCK_BACKEND, 0, store);
  const original = first.create({ cwd: root });
  first.broadcast(original, { type: "user_prompt", text: "remember this" });
  first.broadcast(original, { type: "text_delta", text: "remembered" });
  first.broadcast(original, { type: "turn_end" });
  first.rename(original.id, "durable chat");

  const second = new SessionRegistry(MOCK_BACKEND, 0, store);
  assert.equal(second.get(original.id), undefined, "startup does not eagerly launch an engine");
  assert.deepEqual(
    second.summary().map((row) => [row.sessionId, row.name, row.status, row.viewports]),
    [[original.id, "durable chat", "idle", 0]],
  );

  const restored = second.open(original.id)!;
  assert.equal(restored.id, original.id);
  const replay: WireMsg[] = [];
  second.attach(restored, (msg) => replay.push(msg));
  assert.ok(replay.some((msg) => msg.type === "user_prompt" && msg.text === "remember this"));
  assert.ok(replay.some((msg) => msg.type === "text_delta" && msg.text === "remembered"));
  assert.ok(replay.some((msg) => msg.type === "prompt_options"));

  assert.equal(second.end(original.id), true);
  assert.equal(new SessionCheckpointStore(storeDir).loadAll().sessions.size, 0);
});

test("restoring a checkpoint closes an in-flight browser turn without discarding the session", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-root-"));
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  const store = new SessionCheckpointStore(storeDir);
  const first = new SessionRegistry(MOCK_BACKEND, 0, store);
  const original = first.create({ cwd: root });
  first.broadcast(original, { type: "user_prompt", text: "half finished" });

  const second = new SessionRegistry(MOCK_BACKEND, 0, store);
  const restored = second.open(original.id)!;
  assert.equal(restored.status, "idle");
  assert.equal(
    second.canResume(restored, original.nextSeq - 1),
    false,
    "a browser cursor from the prior daemon cannot skip recovery frames",
  );
  assert.equal(restored.buffer.at(-1)?.type, "turn_end");
  assert.ok(
    restored.buffer.some(
      (msg) => msg.type === "notice" && msg.text.includes("turn was interrupted"),
    ),
  );
  second.end(original.id);
});

test("restoring a checkpoint closes an interrupted shell command", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-root-"));
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  const store = new SessionCheckpointStore(storeDir);
  const first = new SessionRegistry(MOCK_BACKEND, 0, store);
  const original = first.create({ cwd: root });
  first.broadcast(original, { type: "bang_start", command: "long task", id: "bang-1" });
  first.broadcast(original, { type: "bang_output", id: "bang-1", data: "halfway\n" });

  const restored = new SessionRegistry(MOCK_BACKEND, 0, store).open(original.id)!;
  const end = restored.buffer.find(
    (msg): msg is Extract<WireMsg, { type: "bang_end" }> =>
      msg.type === "bang_end" && msg.id === "bang-1",
  );
  assert.deepEqual(end && { type: end.type, id: end.id, exitCode: end.exitCode }, {
    type: "bang_end",
    id: "bang-1",
    exitCode: null,
  });
});

test("explicit End Session cannot be undone by a late adapter callback", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-late-"));
  const store = new SessionCheckpointStore(dir);
  const registry = new SessionRegistry(MOCK_BACKEND, 0, store);
  const entry = registry.create({ cwd: dir });
  assert.equal(registry.end(entry.id), true);

  // Models an async command-catalog result or close-time permission
  // resolution arriving after teardown.
  registry.broadcast(entry, {
    type: "prompt_options",
    options: [{ trigger: "/", value: "/late", label: "late", kind: "command" }],
  });
  assert.equal(store.loadAll().sessions.has(entry.id), false);
  assert.equal(registry.get(entry.id), undefined);
});
