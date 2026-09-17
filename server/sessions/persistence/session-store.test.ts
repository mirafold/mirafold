import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { spawnSync } from "node:child_process";
import { restoreBackend, type Backend } from "../../adapters/index";
import { SessionRegistry } from "../registry";
import { MAX_NEXT_SEQ, SessionCheckpointStore, type StoredSession } from "./session-store";
import type { SessionMsg, WireMsg } from "../../protocol";
import { PROMPT_LABEL_CAP, normalizePromptOptions } from "../../prompt-options";

const MOCK_BACKEND: Backend = { agent: "codex", kind: "none", live: false };

const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, "condition did not become true before timeout");
};

function fixture(id = "deadbeef"): StoredSession {
  return {
    version: 1,
    id,
    cwd: "/tmp",
    bangCwd: "/tmp",
    backend: MOCK_BACKEND,
    promptOptions: [
      { trigger: "$", value: "$next", label: "next", kind: "skill", source: "mirafold" },
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

test("a configured endpoint round-trips as the exact recovery backend", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  const store = new SessionCheckpointStore(dir);
  const stored = fixture();
  stored.backend = {
    agent: "claude-code",
    kind: "local",
    live: true,
    endpoint: "http://127.0.0.1:1111",
    endpointSource: "configured",
    endpointAuth: "none",
  };
  store.write(stored);
  assert.equal(
    store.loadAll().sessions.get(stored.id)?.backend.endpoint,
    "http://127.0.0.1:1111",
  );
});

test("UX.8: a legacy saved Codex skill is attributed before its first replay", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  const store = new SessionCheckpointStore(dir);
  const stored = fixture("oldskill");
  stored.backend = {
    agent: "codex",
    kind: "local",
    live: true,
    provider: "configured-provider",
  };
  stored.promptOptions = [
    { trigger: "$", value: "$workspace-skill", label: "workspace-skill", kind: "skill" },
  ];
  store.write(stored);
  assert.equal(
    store.loadAll().sessions.get(stored.id)?.promptOptions[0].source,
    "codex",
  );
});

test("restore keeps an unauthenticated saved endpoint when daemon configuration changes", () => {
  const prior = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:2222";
  try {
    const stored = fixture();
    stored.backend = {
      agent: "claude-code",
      kind: "local",
      live: true,
      endpoint: "http://127.0.0.1:1111",
      endpointSource: "configured",
      endpointAuth: "none",
    };
    assert.equal(restoreBackend(stored).endpoint, "http://127.0.0.1:1111");
  } finally {
    if (prior === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prior;
  }
});

test("UX.8: restore refuses authenticated endpoint drift before a current credential is used", () => {
  const keys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
  const savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.ANTHROPIC_BASE_URL = "https://endpoint-b.example/v1";
  process.env.ANTHROPIC_AUTH_TOKEN = "current-token";
  try {
    const stored = fixture();
    stored.backend = {
      agent: "claude-code",
      kind: "local",
      live: true,
      endpoint: "https://endpoint-a.example/v1",
      endpointSource: "configured",
      endpointAuth: "auth-token",
    };
    assert.throws(
      () => restoreBackend(stored),
      /authenticated Claude endpoint or credential mode changed/,
    );
  } finally {
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

test("UX.8: restore permits credential rotation at the same bound endpoint and mode", () => {
  const keys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
  const savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.ANTHROPIC_BASE_URL = "https://endpoint-a.example/v1";
  process.env.ANTHROPIC_AUTH_TOKEN = "rotated-token";
  try {
    const stored = fixture();
    stored.backend = {
      agent: "claude-code",
      kind: "local",
      live: true,
      endpoint: "https://endpoint-a.example/v1",
      endpointSource: "configured",
      endpointAuth: "auth-token",
    };
    assert.deepEqual(restoreBackend(stored), stored.backend);
  } finally {
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
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

  const registry = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store: store });
  assert.throws(() => registry.open("badc0ffe"), /saved but its checkpoint is unavailable/);
  assert.equal(registry.end("badc0ffe"), true, "explicit end is the deletion path");
  assert.equal(readdirSync(dir).length, 0);
});

test("a catalog entry capped by the daemon's own caps round-trips through the checkpoint", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-caps-"));
  const store = new SessionCheckpointStore(dir);
  const stored = fixture("caps");
  const long = "x".repeat(5_000);
  stored.promptOptions = normalizePromptOptions([
    { trigger: "/", value: "/long", label: long, description: long, argumentHint: long, kind: "command" },
  ]);
  store.write(stored);
  const reloaded = store.loadAll().sessions.get("caps");
  assert.equal(reloaded?.promptOptions[0]?.label.length, PROMPT_LABEL_CAP + 1);
});

test("UX.8: strict checkpoint decoding accepts every persistable transcript frame", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-schema-"));
  const store = new SessionCheckpointStore(dir);
  const stored = fixture("schemaok");
  stored.promptOptions = [
    {
      trigger: "$",
      value: "$audit",
      label: "audit",
      description: "workspace-defined audit",
      kind: "skill",
      source: "codex",
    },
  ];
  const bodies: SessionMsg[] = [
    { type: "text_delta", text: "hello" },
    { type: "status", state: "tool", label: "Read" },
    { type: "turn_end" },
    { type: "error", message: "failed" },
    { type: "error", message: "request refused", terminal: false },
    { type: "render", component: "card", props: { title: "safe" }, id: "r1" },
    {
      type: "picker",
      id: "pick1",
      title: "Choose",
      rows: [{ label: "one", detail: "first", current: true, text: "/model one" }],
      hint: "pick one",
    },
    { type: "tool_use", name: "Read", detail: "a.ts", id: "t1", input: { path: "a.ts" } },
    { type: "tool_update", detail: "b.ts", id: "t1", input: { path: "b.ts" } },
    { type: "tool_result", output: "ok", isError: false, id: "t1", truncatedBytes: 0 },
    { type: "permission_request", tool: "Bash", detail: "echo ok", id: "p1" },
    { type: "permission_resolved", id: "p1", allow: false },
    { type: "user_prompt", text: "do it" },
    { type: "artifact", html: "<p>safe</p>", id: "a1", title: "Artifact" },
    { type: "usage", model: "model", inputTokens: 2, outputTokens: 3, costUsd: 0.01 },
    { type: "thinking_delta", text: "hmm" },
    // The subagent lane's parented variants (SA.2/SA.3): a reverted schema
    // widening would silently strip a deck's replay — pinned here
    // (test-audit 2026-08-14).
    { type: "text_delta", text: "child narration", parentId: "t1" },
    { type: "thinking_delta", text: "child reasoning", parentId: "t1" },
    { type: "permission_request", tool: "bash", detail: "touch x", id: "p2", parentId: "t1" },
    { type: "notice", text: "retrying", kind: "retry", source: "codex" },
    { type: "bang_start", command: "echo ok", id: "b1", silent: true },
    { type: "bang_output", data: "ok\n", id: "b1" },
    { type: "bang_end", id: "b1", exitCode: 0 },
    // Phase TF: the additive display facts, the replacement snapshot, and
    // the task lifecycle all persist — a reverted schema would strip a
    // reload's exit codes, tails, and task states.
    { type: "tool_use", name: "Shell", detail: "rg foo", id: "t2", input: { command: "rg foo" }, actions: [{ kind: "search", target: "foo" }] },
    { type: "tool_update", id: "t2", elapsedMs: 1200 },
    // PR #122: a background child's patch snapshot carries its parentage; a
    // schema without the field made the registry drop the whole frame.
    { type: "tool_update", id: "t2", detail: "Updated a.ts", input: { changes: [] }, parentId: "t1" },
    { type: "tool_output_snapshot", id: "t2", revision: 4, head: "a\n", tail: "z\n", omittedBytes: 99, parentId: "t1" },
    { type: "tool_result", output: "head", id: "t2", tail: "tail", omittedBytes: 12, exitCode: 1, durationMs: 40 },
    { type: "task_update", id: "t1", state: "completed", label: "find auth", agentType: "Explore", action: "Grep", report: "done", reportTail: "…", reportOmittedBytes: 1, elapsedMs: 3000, parentId: "t0" },
    { type: "task_update", id: "t3", state: "running", label: "again", attempt: 2 },
    { type: "tool_use", name: "Bash", id: "t4", parentId: "t3", attempt: 2 },
  ];
  stored.buffer = bodies.map((body, index) => ({ ...body, seq: index + 1 }) as SessionMsg);
  stored.nextSeq = stored.buffer.length + 1;
  store.write(stored);

  const loaded = store.loadAll();
  assert.equal(loaded.errors.size, 0);
  assert.deepEqual(
    loaded.sessions.get(stored.id)?.buffer.map((msg) => msg.type),
    bodies.map((msg) => msg.type),
  );
  const loadedBuffer = loaded.sessions.get(stored.id)?.buffer ?? [];
  const silentBang = loadedBuffer.find(
    (msg): msg is Extract<SessionMsg, { type: "bang_start" }> =>
      msg.type === "bang_start" && msg.id === "b1",
  );
  assert.equal(silentBang?.silent, true);
  const requestError = loadedBuffer.find(
    (msg): msg is Extract<SessionMsg, { type: "error" }> =>
      msg.type === "error" && msg.message === "request refused",
  );
  assert.equal(requestError?.terminal, false);
});

test("UX.8: malformed, control, and non-transcript checkpoint frames never replay", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-hostile-"));
  const cases: Array<[string, unknown[], unknown[]?]> = [
    [
      "badshape",
      [{ type: "permission_request", tool: { forged: true }, detail: "x", id: "p1", seq: 1 }],
    ],
    ["plumbing", [{ type: "session_ended", sessionId: "victim", seq: 1 }]],
    ["replayed", [{ type: "notice", text: "forged", seq: 1, replay: true }]],
    [
      "badseq",
      [
        { type: "text_delta", text: "one", seq: 2 },
        { type: "text_delta", text: "two", seq: 2 },
      ],
    ],
    [
      "badprompt",
      [{ type: "turn_end", seq: 1 }],
      [
        {
          trigger: "$",
          value: "$audit",
          label: "safe\u202Etxt",
          kind: "skill",
          source: "codex",
        },
      ],
    ],
  ];

  for (const [id, buffer, promptOptions] of cases) {
    const raw = {
      ...fixture(id),
      buffer,
      nextSeq: buffer.length + 2,
      ...(promptOptions ? { promptOptions } : {}),
    };
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(raw), { mode: 0o600 });
  }

  const staleNextSeq = {
    ...fixture("stalenext"),
    buffer: [{ type: "text_delta", text: "collision", seq: 1 }],
    nextSeq: 1,
  };
  writeFileSync(path.join(dir, "stalenext.json"), JSON.stringify(staleNextSeq), {
    mode: 0o600,
  });

  const loaded = new SessionCheckpointStore(dir).loadAll();
  assert.equal(loaded.sessions.size, 0);
  for (const [id] of cases) {
    assert.match(loaded.errors.get(id) ?? "", /malformed/);
  }
  assert.match(loaded.errors.get("stalenext") ?? "", /sequence/);
});

test("UX.8: a saved endpoint echoed in a diagnostic is scrubbed before replay", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-redaction-"));
  const store = new SessionCheckpointStore(dir);
  const stored = fixture("redacted");
  const endpoint = "https://tenant.example/private/token-path";
  stored.backend = {
    agent: "claude-code",
    kind: "local",
    live: true,
    endpoint,
    endpointSource: "configured",
    endpointAuth: "none",
  };
  stored.buffer = [
    { type: "error", message: `request ${endpoint}/messages failed`, seq: 1 },
  ];
  stored.nextSeq = 2;
  store.write(stored);

  const error = store.loadAll().sessions.get(stored.id)?.buffer[0];
  assert.equal(error?.type, "error");
  if (error?.type === "error") {
    assert.equal(error.message, "request [selected endpoint]/messages failed");
    assert.doesNotMatch(error.message, /tenant|private|token-path/);
  }
});

test("a new registry lists and lazily reopens the exact saved transcript", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-root-"));
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  const store = new SessionCheckpointStore(storeDir);
  const first = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store: store });
  const original = first.create({ cwd: root });
  first.broadcast(original, { type: "user_prompt", text: "remember this" });
  first.broadcast(original, { type: "text_delta", text: "remembered" });
  first.broadcast(original, { type: "turn_end" });
  first.rename(original.id, "durable chat");

  const second = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store: store });
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

test("a viewportless dormant reopen arms the ordinary idle unload", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-root-"));
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  const store = new SessionCheckpointStore(storeDir);
  const stored = fixture("idlebeef");
  stored.cwd = root;
  stored.bangCwd = root;
  store.write(stored);

  const registry = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store: store, idleTimeoutMs: 15 });
  const reopened = registry.open(stored.id)!;
  assert.ok(reopened.idleTimer, "activation must arm an unload without a viewport attach");
  await waitUntil(() => registry.get(stored.id) === undefined);
  assert.equal(
    registry.summary().some((row) => row.sessionId === stored.id),
    true,
    "idle unload keeps the durable dormant row",
  );
  assert.equal(registry.end(stored.id), true);
});

test("restoring a checkpoint closes an in-flight browser turn without discarding the session", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-root-"));
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  const store = new SessionCheckpointStore(storeDir);
  const first = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store: store });
  const original = first.create({ cwd: root });
  first.broadcast(original, { type: "user_prompt", text: "half finished" });

  const second = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store: store });
  const restored = second.open(original.id)!;
  assert.equal(restored.status, "idle");
  assert.equal(
    second.canResume(restored, original.ring.nextSeq - 1),
    false,
    "a browser cursor from the prior daemon cannot skip recovery frames",
  );
  assert.equal(restored.ring.buffer.at(-1)?.type, "turn_end");
  assert.ok(
    restored.ring.buffer.some(
      (msg) => msg.type === "notice" && msg.text.includes("turn was interrupted"),
    ),
  );
  second.end(original.id);
});

test("restoring a checkpoint closes an interrupted shell command", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-root-"));
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  const store = new SessionCheckpointStore(storeDir);
  const first = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store: store });
  const original = first.create({ cwd: root });
  first.broadcast(original, { type: "bang_start", command: "long task", id: "bang-1" });
  first.broadcast(original, { type: "bang_output", id: "bang-1", data: "halfway\n" });

  const restored = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store: store }).open(original.id)!;
  const end = restored.ring.buffer.find(
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
  const registry = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store: store });
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

test("a failed durable delete leaves the live session and filesystem watcher intact", () => {
  class FailingDeleteStore extends SessionCheckpointStore {
    failDelete = true;

    override delete(id: string) {
      if (this.failDelete) {
        throw Object.assign(new Error("read-only checkpoint store"), { code: "EROFS" });
      }
      super.delete(id);
    }
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-delete-"));
  const store = new FailingDeleteStore(dir);
  const registry = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store: store });
  const entry = registry.create({ cwd: dir });
  let stopped = false;
  const watch = {
    ready: Promise.resolve(),
    stop: () => {
      stopped = true;
    },
  };
  entry.fsWatch = watch;

  assert.throws(() => registry.end(entry.id), /read-only checkpoint store/);
  assert.equal(registry.get(entry.id), entry, "the engine remains registered");
  assert.equal(entry.fsWatch, watch, "the live watcher remains attached");
  assert.equal(stopped, false);

  store.failDelete = false;
  assert.equal(registry.end(entry.id), true);
  assert.equal(stopped, true);
});

test("BUGFIX: OC.4c backend shapes survive a restart — decode accepts them all", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-oc-"));
  const store = new SessionCheckpointStore(dir);
  // The exact shapes snapshot() writes after the adapter publishes its
  // classified kind — every one was "malformed checkpoint backend" before,
  // so NO OpenCode session survived a daemon restart (bughunt round 2).
  const backends = [
    { agent: "opencode", kind: "api-key", live: true, provider: "deepseek", model: "deepseek/deepseek-v4" },
    { agent: "opencode", kind: "gateway", live: true, provider: "opencode", model: "opencode/big-pickle" },
    { agent: "opencode", kind: "subscription", live: true, provider: "openai" },
    { agent: "opencode", kind: "local", live: true, provider: "ollama" },
  ] as const;
  backends.forEach((backend, at) => {
    const stored = {
      ...fixture(),
      id: `oc-restart-${at}`,
      backend: backend as unknown as ReturnType<typeof fixture>["backend"],
      promptOptions: [
        // Engine command rows carry source:"opencode" — the enum rejected it.
        { trigger: "/", value: "/init", label: "init", kind: "command", source: "opencode" },
      ] as ReturnType<typeof fixture>["promptOptions"],
    };
    store.write(stored);
  });
  const loaded = store.loadAll();
  assert.equal(loaded.errors.size, 0, [...loaded.errors.values()].join("; "));
  assert.equal(loaded.sessions.size, backends.length);
  assert.equal(loaded.sessions.get("oc-restart-1")?.backend.kind, "gateway");
  assert.equal(loaded.sessions.get("oc-restart-0")?.backend.provider, "deepseek");
  // Non-opencode agents keep the old strictness: provider still needs local.
  const bad = { ...fixture(), id: "codex-bad", backend: { agent: "codex", kind: "api-key", live: true, provider: "x" } as unknown as ReturnType<typeof fixture>["backend"] };
  store.write(bad);
  assert.ok(store.loadAll().errors.has("codex-bad"));
});

// AUDIT 2026-08-26: the zod rewrite kept `seq`'s safe-integer bound but
// dropped `nextSeq`'s (main checked Number.isSafeInteger). 1e300 is an
// integer to zod; adopted, `nextSeq++` is a no-op and every later message
// carries the same seq for the session's life.
test("a checkpoint whose nextSeq is beyond the safe-integer range is refused, not adopted", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-session-store-"));
  const store = new SessionCheckpointStore(dir);
  for (const [id, nextSeq] of [["hugenext", 1e300], ["floatnext", 2 ** 53 + 2], ["edgenext", Number.MAX_SAFE_INTEGER], ["overroom", MAX_NEXT_SEQ + 1]] as const) {
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ...fixture(id), buffer: [], nextSeq }), { mode: 0o600 });
  }
  const loaded = store.loadAll();
  assert.equal(loaded.sessions.size, 0);
  assert.ok(loaded.errors.has("hugenext"));
  assert.ok(loaded.errors.has("floatnext"));
  assert.ok(loaded.errors.has("edgenext"), "the safe-integer edge itself pins the stream after one message");
  assert.ok(loaded.errors.has("overroom"));
});

// AUDIT 2026-08-26: a discovered endpoint is loopback by construction when
// picked; a tampered checkpoint could otherwise restore a session pointed at
// any host and ship the conversation there with no prompt.
test("AUDIT: a saved discovered endpoint that is not on this machine is refused on restore", () => {
  for (const agent of ["claude-code", "codex"] as const) {
    const stored = fixture();
    stored.backend = { agent, kind: "local", live: true, endpoint: "http://attacker.example:11434", endpointSource: "discovered", ...(agent === "claude-code" ? { endpointAuth: "none" as const } : {}) };
    assert.throws(() => restoreBackend(stored), /on this machine/);
    stored.backend = { ...stored.backend, endpoint: "http://127.0.0.1:11434" };
    assert.equal(restoreBackend(stored).endpoint, "http://127.0.0.1:11434", `${agent}: a loopback discovered endpoint still restores`);
  }
});

// Cold review (2026-08-26): the configured-but-unauthenticated branch restored
// a saved endpoint verbatim — a tampered checkpoint naming any host shipped
// the conversation there. Loopback restores; anything else must still be this
// daemon's own configured endpoint.
test("AUDIT: a saved unauthenticated configured endpoint restores only if loopback or still configured", () => {
  const prior = process.env.ANTHROPIC_BASE_URL;
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const stored = fixture();
    const backend = (endpoint: string) => ({ agent: "claude-code" as const, kind: "local" as const, live: true, endpoint, endpointSource: "configured" as const, endpointAuth: "none" as const });
    process.env.ANTHROPIC_BASE_URL = "http://gateway.internal:8080";
    stored.backend = backend("http://attacker.example:8080");
    assert.throws(() => restoreBackend(stored), /not this daemon's configured endpoint/);
    stored.backend = backend("http://gateway.internal:8080");
    assert.equal(restoreBackend(stored).endpoint, "http://gateway.internal:8080", "the current configuration still restores");
    stored.backend = backend("http://127.0.0.1:11434");
    assert.equal(restoreBackend(stored).endpoint, "http://127.0.0.1:11434", "loopback restores regardless");
  } finally {
    if (prior === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prior;
    if (priorKey !== undefined) process.env.ANTHROPIC_API_KEY = priorKey;
    if (priorToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = priorToken;
  }
});

// Cold review (2026-08-26): a LAN server the operator listed in
// MIRAFOLD_LOCAL_ENDPOINTS is a real "local" endpoint — its saved sessions
// must restore; an unlisted host still must not.
test("AUDIT: a saved discovered endpoint restores when it is a current MIRAFOLD_LOCAL_ENDPOINTS target", () => {
  const prior = process.env.MIRAFOLD_LOCAL_ENDPOINTS;
  process.env.MIRAFOLD_LOCAL_ENDPOINTS = "http://192.168.1.50:11434";
  try {
    const stored = fixture();
    stored.backend = { agent: "codex", kind: "local", live: true, endpoint: "http://192.168.1.50:11434", endpointSource: "discovered" };
    assert.equal(restoreBackend(stored).endpoint, "http://192.168.1.50:11434");
    stored.backend = { ...stored.backend, endpoint: "http://192.168.1.51:11434" };
    assert.throws(() => restoreBackend(stored), /neither on this machine nor/);
  } finally {
    if (prior === undefined) delete process.env.MIRAFOLD_LOCAL_ENDPOINTS; else process.env.MIRAFOLD_LOCAL_ENDPOINTS = prior;
  }
});

// ---- Phase CPERF: the routine (interior-stream) save leaves the loop ------
// Every race below is deterministic: HeldStore parks a prepared routine save
// just before its validity check, the test performs the competing operation,
// then releases it. The temp file exists on disk while held, exactly as it
// would mid-fsync in production.

class HeldStore extends SessionCheckpointStore {
  holding = true;
  prepared = 0;
  private holds = new Map<string, () => void>();
  private waiters: (() => void)[] = [];

  protected override routineHold(id: string): Promise<void> | undefined {
    this.prepared++;
    if (!this.holding) return undefined;
    return new Promise<void>((resolve) => {
      this.holds.set(id, resolve);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  isHeld(id: string) {
    return this.holds.has(id);
  }

  async whenHeld(id: string, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.holds.has(id)) {
      if (Date.now() > deadline) throw new Error(`routine save for ${id} was never held`);
      await Promise.race([
        new Promise<void>((wake) => this.waiters.push(wake)),
        new Promise((r) => setTimeout(r, 50)),
      ]);
    }
  }

  release(id: string) {
    const resolve = this.holds.get(id);
    assert.ok(resolve, `no held routine save for ${id}`);
    this.holds.delete(id);
    resolve();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempFiles = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".tmp"));
const onDisk = (store: SessionCheckpointStore, id: string) => store.loadAll().sessions.get(id);

test("CPERF.2: a held routine save leaves the loop free, and a newer synchronous save wins", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-"));
  const store = new HeldStore(dir);
  const v1 = fixture();
  const v2 = { ...fixture(), name: "newer boundary state" };

  const routine = store.writeRoutine(v1);
  await store.whenHeld(v1.id);
  assert.equal(tempFiles(dir).length, 1, "the prepared record waits as a sibling temp file");
  // A separate callback runs while the preparation is parked.
  let ticked = false;
  await new Promise<void>((r) => setImmediate(() => ((ticked = true), r())));
  assert.equal(ticked, true);

  store.write(v2);
  store.release(v1.id);
  assert.equal(await routine, "superseded");
  assert.deepEqual(onDisk(store, v1.id), v2, "the older preparation never landed over the boundary save");
  assert.deepEqual(tempFiles(dir), [], "the superseded temp file is removed");
});

test("CPERF.2: a held routine save cannot resurrect a deleted session", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-"));
  const store = new HeldStore(dir);
  const v1 = fixture();
  store.write(v1);

  const routine = store.writeRoutine({ ...v1, name: "streamed after" });
  await store.whenHeld(v1.id);
  store.delete(v1.id);
  store.release(v1.id);
  assert.equal(await routine, "superseded");
  assert.equal(existsSync(path.join(dir, `${v1.id}.json`)), false, "no file reappears");
  assert.deepEqual(tempFiles(dir), []);
});

test("CPERF.2: the routine snapshot is serialized before the first yield", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-"));
  const store = new HeldStore(dir);
  const session = fixture();
  const expected = structuredClone(session);

  const routine = store.writeRoutine(session);
  // The registry's snapshot shares the live ring array: mutate it the way
  // streaming would while the save is still preparing.
  session.buffer.push({ type: "text_delta", text: "arrived later", seq: 4 });
  session.nextSeq = 5;
  session.name = "renamed mid-flight";
  await store.whenHeld(session.id);
  store.release(session.id);
  assert.equal(await routine, "committed");
  assert.deepEqual(onDisk(store, session.id), expected);
});

test("CPERF.2: a committed routine save is one owner-only atomic record", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-"));
  const store = new HeldStore(dir);
  store.holding = false;
  const stored = fixture();
  assert.equal(await store.writeRoutine(stored), "committed");
  assert.deepEqual(readdirSync(dir), [`${stored.id}.json`], "no temp file survives the rename");
  assert.deepEqual(onDisk(store, stored.id), stored);
  if (process.platform !== "win32") {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(dir, `${stored.id}.json`)).mode & 0o777, 0o600);
  }
});

test("CPERF.2: a routine save that fails before replacement keeps the last good file and releases everything", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    for (const stage of ["before the temp file exists", "after the payload is written"] as const) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-"));
      class FailingPrepare extends SessionCheckpointStore {
        failing = true;
        protected override async prepareRoutineFile(temp: string, data: string) {
          if (!this.failing) return super.prepareRoutineFile(temp, data);
          if (stage === "after the payload is written") await super.prepareRoutineFile(temp, data);
          throw Object.assign(new Error(`disk failed ${stage}`), { code: "EIO" });
        }
      }
      const store = new FailingPrepare(dir);
      const good = fixture();
      store.write(good);
      await assert.rejects(store.writeRoutine({ ...good, name: "never lands" }), /disk failed/);
      assert.deepEqual(onDisk(store, good.id), good, `last good file intact (${stage})`);
      assert.deepEqual(tempFiles(dir), [], `temp removed (${stage})`);
      // Bookkeeping released on this instance: the next save is admitted, not "busy".
      store.failing = false;
      assert.equal(await store.writeRoutine(good), "committed");
    }

    // A real rename failure: the target path is occupied by a directory.
    const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-"));
    const store = new HeldStore(dir);
    store.holding = false;
    const stored = fixture();
    mkdirSync(path.join(dir, `${stored.id}.json`));
    await assert.rejects(store.writeRoutine(stored));
    assert.deepEqual(tempFiles(dir), [], "the temp is removed after a failed rename");
    rmSync(path.join(dir, `${stored.id}.json`), { recursive: true });
    assert.equal(await store.writeRoutine(stored), "committed", "the id is not stuck busy after a failure");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(rejections, [], "every asynchronous rejection is caught");
});

test("CPERF.2: one routine save per session at a time; other sessions prepare independently", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-"));
  const store = new HeldStore(dir);
  const a = fixture("session-a");
  const b = fixture("session-b");

  const first = store.writeRoutine(a);
  await store.whenHeld(a.id);
  assert.equal(await store.writeRoutine({ ...a, name: "second request" }), "busy");
  assert.equal(store.prepared, 1, "a busy request serializes and prepares nothing");
  assert.equal(tempFiles(dir).length, 1);

  // A superseded-but-unsettled save still counts as in flight.
  store.write(a);
  assert.equal(await store.writeRoutine({ ...a, name: "third request" }), "busy");
  assert.equal(store.prepared, 1);

  const other = store.writeRoutine(b);
  await store.whenHeld(b.id);
  assert.equal(store.prepared, 2, "a different session prepares while the first is held");
  store.release(b.id);
  assert.equal(await other, "committed");

  store.release(a.id);
  assert.equal(await first, "superseded");
  // The old completion released only its own bookkeeping: a new save for
  // the id is admitted, and while it is held the id reads busy again.
  const next = store.writeRoutine({ ...a, name: "after settlement" });
  await store.whenHeld(a.id);
  assert.equal(await store.writeRoutine(a), "busy", "the newer operation's bookkeeping is intact");
  store.release(a.id);
  assert.equal(await next, "committed");
  assert.equal(onDisk(store, a.id)?.name, "after settlement");
  assert.deepEqual(tempFiles(dir), []);
});

test("CPERF.6: loading sweeps only this store's own temp files left by a process that no longer exists", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-"));
  const store = new SessionCheckpointStore(dir);
  const stored = fixture();
  store.write(stored);
  const uuid = "0f2b3a44-9c1e-4a7b-8d55-1c2d3e4f5a6b";
  // A pid from a process that exited: allocate a child, let it exit.
  const gone = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const orphan = `.${stored.id}.${gone}.${uuid}.tmp`;
  const ours = `.${stored.id}.${process.pid}.${uuid}.tmp`;
  const foreign = `${stored.id}.${gone}.tmp`; // not the store's naming
  for (const name of [orphan, ours, foreign]) writeFileSync(path.join(dir, name), "{");

  const loaded = store.loadAll();
  assert.deepEqual(loaded.sessions.get(stored.id), stored);
  assert.equal(loaded.errors.size, 0);
  assert.deepEqual(readdirSync(dir).sort(), [ours, `${stored.id}.json`, foreign].sort());
});

// Registry-level: routing, coalescing, and the lifecycle races. Real 250 ms
// debounce, mock engine (inert until prompted), deltas straight through.

function heldRegistry(options: { idleTimeoutMs?: number; store?: HeldStore } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-reg-"));
  const store = options.store ?? new HeldStore(dir);
  const registry = new SessionRegistry({
    backend: MOCK_BACKEND,
    deltaCoalesceMs: 0,
    store,
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
  });
  const entry = registry.create({ cwd: dir });
  const seen: WireMsg[] = [];
  const viewport = (msg: WireMsg) => void seen.push(msg);
  registry.attach(entry, viewport);
  const delta = (text: string) => registry.broadcast(entry, { type: "text_delta", text });
  const bufferOnDisk = () => onDisk(store, entry.id)?.buffer ?? [];
  return { dir, store, registry, entry, seen, viewport, delta, bufferOnDisk };
}

test("CPERF.3: a burst during an in-flight routine save is coalesced into one later save of the latest state", async () => {
  const { store, registry, entry, delta, bufferOnDisk } = heldRegistry();
  delta("first");
  await store.whenHeld(entry.id);
  assert.equal(store.prepared, 1);
  for (let i = 0; i < 50; i++) delta(`burst ${i}`);
  await sleep(350); // past the debounce: the request must only mark state dirty
  assert.equal(store.prepared, 1, "no second preparation while one is in flight");
  assert.equal(entry.checkpointDirty, true);

  store.release(entry.id);
  await store.whenHeld(entry.id); // exactly one follow-up, through the timer
  assert.equal(store.prepared, 2);
  store.release(entry.id);
  await waitUntil(() => bufferOnDisk().length === 51, 3_000);
  assert.equal((bufferOnDisk().at(-1) as { text: string }).text, "burst 49");
  await sleep(350);
  assert.equal(store.prepared, 2, "a completed save does not spawn another without new state");
  registry.end(entry.id);
});

test("CPERF.3: continuous output saves without waiting for quiet", async () => {
  const { store, registry, entry, delta, bufferOnDisk } = heldRegistry();
  store.holding = false;
  let n = 0;
  const stream = setInterval(() => delta(`line ${n++}`), 10);
  try {
    await waitUntil(() => bufferOnDisk().length > 0, 3_000);
    const first = bufferOnDisk().length;
    await waitUntil(() => bufferOnDisk().length > first, 3_000);
  } finally {
    clearInterval(stream);
  }
  assert.ok(n > 0);
  registry.end(entry.id);
});

test("CPERF.3: a successful boundary suppresses its redundant routine follow-up; a later message causes a new save", async () => {
  const { store, registry, entry, delta, bufferOnDisk } = heldRegistry();
  delta("interior");
  await store.whenHeld(entry.id);
  registry.broadcast(entry, { type: "turn_end" }); // synchronous, covers everything so far
  assert.equal(bufferOnDisk().length, 2, "the boundary landed before fanout");
  store.release(entry.id);
  await sleep(400);
  assert.equal(store.prepared, 1, "no follow-up: the boundary already covers the state");
  assert.equal(bufferOnDisk().length, 2);

  delta("after the boundary");
  await store.whenHeld(entry.id);
  assert.equal(store.prepared, 2);
  store.release(entry.id);
  await waitUntil(() => bufferOnDisk().length === 3, 3_000);
  registry.end(entry.id);
});

test("CPERF.3: boundary supersession, one new message, old-work settlement, then silence — the message is saved", async () => {
  for (const order of ["settle before the debounce fires", "settle after the debounce fires"] as const) {
    const { store, registry, entry, delta, bufferOnDisk } = heldRegistry();
    delta("interior");
    await store.whenHeld(entry.id);
    registry.broadcast(entry, { type: "turn_end" });
    delta("the one message after the boundary");
    if (order === "settle after the debounce fires") {
      await sleep(350);
      assert.equal(store.prepared, 1, "the debounce found the old save in flight and only marked dirty");
    }
    store.release(entry.id);
    await store.whenHeld(entry.id);
    assert.equal(store.prepared, 2, `exactly one follow-up (${order})`);
    store.release(entry.id);
    await waitUntil(() => bufferOnDisk().length === 3, 3_000);
    assert.equal((bufferOnDisk().at(-1) as { text: string }).text, "the one message after the boundary");
    registry.end(entry.id);
  }
});

test("CPERF.3: a failed routine save logs once, does not retry on its own, and the next event saves the state", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-reg-"));
  class FlakyStore extends HeldStore {
    failures = 0;
    failNext = true;
    protected override async prepareRoutineFile(temp: string, data: string) {
      if (this.failNext) {
        this.failNext = false;
        this.failures++;
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      }
      await super.prepareRoutineFile(temp, data);
    }
  }
  const store = new FlakyStore(dir);
  store.holding = false;
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const { registry, entry, delta, bufferOnDisk } = heldRegistry({ store });
  try {
    delta("lost to the failure");
    await sleep(700);
    assert.equal(store.failures, 1);
    assert.equal(store.prepared, 0, "no automatic retry after the failure");
    assert.equal(bufferOnDisk().length, 0);
    assert.equal(entry.checkpointDirty, true, "the state stays eligible");

    delta("the next event");
    await waitUntil(() => bufferOnDisk().length === 2, 3_000);
    assert.equal(store.prepared, 1);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(rejections, []);
  registry.end(entry.id);
});

test("CPERF.4: End Session while a routine save is held — deletion sticks", async () => {
  const { dir, store, registry, entry, delta } = heldRegistry();
  delta("streamed");
  await store.whenHeld(entry.id);
  assert.equal(registry.end(entry.id), true);
  assert.equal(existsSync(path.join(dir, `${entry.id}.json`)), false);
  store.release(entry.id);
  await entry.routineSave;
  assert.equal(existsSync(path.join(dir, `${entry.id}.json`)), false, "old work cannot recreate the file");
  assert.deepEqual(tempFiles(dir), []);
  assert.equal(registry.get(entry.id), undefined);
});

// A real unlink refusal (the directory loses its write bit) rather than an
// overridden delete(): the failure must happen BELOW the store's own
// invalidation of the held save, exactly where a disk error would.
const cannotDropPermissions = process.platform === "win32" || process.getuid?.() === 0;

test("CPERF.4: a failed End Session while a routine save is held keeps the session saveable", { skip: cannotDropPermissions }, async () => {
  const { dir, store, registry, entry, delta, bufferOnDisk } = heldRegistry();
  registry.broadcast(entry, { type: "turn_end" });
  delta("streamed");
  await store.whenHeld(entry.id);
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => registry.end(entry.id), /EACCES|EPERM/);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(registry.get(entry.id), entry, "the session remains live");
  store.release(entry.id);
  await entry.routineSave;
  assert.equal(bufferOnDisk().length, 1, "the last good file survives; the superseded save did not land");
  assert.deepEqual(tempFiles(dir), []);

  // The still-live state is saved by the next routine attempt.
  await store.whenHeld(entry.id);
  store.release(entry.id);
  await waitUntil(() => bufferOnDisk().length === 2, 3_000);
  assert.equal(registry.end(entry.id), true);
  assert.equal(existsSync(path.join(dir, `${entry.id}.json`)), false);
});

test("CPERF.4: a failed rename rolls back, and neither the canceled save nor a later one overwrites the rollback", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-reg-"));
  class FailingSyncDisk extends HeldStore {
    failWrites = false;
    protected override writeRecordSync(temp: string, data: string) {
      if (this.failWrites) throw Object.assign(new Error("disk is read-only"), { code: "EROFS" });
      super.writeRecordSync(temp, data);
    }
  }
  const store = new FailingSyncDisk(dir);
  const { registry, entry, delta } = heldRegistry({ store });
  const original = entry.name;
  registry.broadcast(entry, { type: "turn_end" });
  delta("streamed");
  await store.whenHeld(entry.id);

  store.failWrites = true;
  assert.equal(registry.rename(entry.id, "a name that must not lie"), false);
  assert.equal(entry.name, original);
  store.release(entry.id);
  await entry.routineSave;
  assert.equal(onDisk(store, entry.id)?.name, original, "the canceled save did not land its stale record");
  assert.equal(onDisk(store, entry.id)?.buffer.length, 1);
  assert.deepEqual(tempFiles(dir), []);

  store.failWrites = false;
  await store.whenHeld(entry.id); // the still-live streamed state is saved fresh
  store.release(entry.id);
  await waitUntil(() => onDisk(store, entry.id)?.buffer.length === 2, 3_000);
  assert.equal(onDisk(store, entry.id)?.name, original);
  assert.equal(registry.rename(entry.id, "renamed for real"), true);
  assert.equal(onDisk(store, entry.id)?.name, "renamed for real");
  registry.end(entry.id);
});

test("CPERF.4: idle unload and reopen of the same id while old preparation is held — the old callback never touches the new entry", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirafold-cperf-reg-"));
  const store = new HeldStore(dir);
  const registry = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store, idleTimeoutMs: 450 });
  const first = registry.create({ cwd: dir }); // no viewport: the idle unload is armed
  registry.broadcast(first, { type: "text_delta", text: "before unload" });
  await store.whenHeld(first.id);
  await waitUntil(() => registry.get(first.id) === undefined, 3_000); // unloaded: its sync save superseded the held one
  assert.equal(store.loadAll().sessions.get(first.id)?.buffer.length, 1);

  const second = registry.open(first.id)!;
  assert.notEqual(second, first);
  registry.attach(second, () => undefined); // viewed: no idle unload this time
  registry.broadcast(second, { type: "text_delta", text: "after reopen" });
  await sleep(350); // the new entry's debounce fires while the old id is still busy
  assert.equal(store.prepared, 1, "the new entry's request found the old preparation still in flight");
  assert.equal(second.checkpointDirty, true);
  assert.ok(second.checkpointTimer || second.routineSave, "the new entry keeps its own pending state");

  store.release(first.id);
  await store.whenHeld(second.id);
  assert.equal(store.prepared, 2);
  assert.equal(first.routineSave, undefined, "the old entry's bookkeeping was released by its own completion");
  store.release(second.id);
  // Recovery closed the interrupted turn (notice + turn_end) before the new
  // delta, so the record is the reopened ring, ending with the new message.
  const saved = () => store.loadAll().sessions.get(first.id)?.buffer ?? [];
  await waitUntil(() => saved().length === second.ring.buffer.length, 3_000);
  assert.equal((saved().at(-1) as { text: string }).text, "after reopen");
  assert.deepEqual(tempFiles(dir), []);
  registry.end(first.id);
});

test("CPERF.4: a viewport observing turn_end can read the complete checkpoint at once; unrelated sessions keep flowing during a held save", async () => {
  const { dir, store, registry, entry, delta } = heldRegistry();
  const other = registry.create({ cwd: dir });
  const otherSeen: WireMsg[] = [];
  registry.attach(other, (msg) => void otherSeen.push(msg));

  delta("streamed");
  await store.whenHeld(entry.id);
  let observedOnDisk: SessionMsg[] | undefined;
  registry.attach(entry, (msg) => {
    if (msg.type === "turn_end") observedOnDisk = onDisk(store, entry.id)?.buffer;
  });
  registry.broadcast(entry, { type: "turn_end" });
  assert.equal(observedOnDisk?.at(-1)?.type, "turn_end", "the record was durable before the viewport saw the frame");

  const before = otherSeen.length;
  registry.broadcast(other, { type: "text_delta", text: "another session streams" });
  registry.broadcast(other, { type: "turn_end" });
  assert.equal(otherSeen.length, before + 2, "an unrelated session is not blocked by the held preparation");
  assert.equal(onDisk(store, other.id)?.buffer.length, 2);

  store.release(entry.id);
  await entry.routineSave;
  assert.deepEqual(tempFiles(dir), []);
  registry.end(entry.id);
  registry.end(other.id);
});
