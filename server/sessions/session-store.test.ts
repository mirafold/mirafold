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

import { restoreBackend, type Backend } from "../adapters";
import { SessionRegistry } from "./registry";
import { MAX_NEXT_SEQ, SessionCheckpointStore, type StoredSession } from "./session-store";
import type { SessionMsg, WireMsg } from "../protocol";
import { PROMPT_LABEL_CAP, normalizePromptOptions } from "../prompt-options";

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
