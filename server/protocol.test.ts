import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg, ClientMsg, SessionMeta, Action } from "./protocol";

// The wire protocol frozen in executable form. The first non-negotiable
// ("later work ADDS message types, never reshapes existing ones") is otherwise
// only a comment. Here it has two teeth:
//
//   1. COMPILE-TIME (enforced by `yarn typecheck`, the commit gate). Each
//      fixture map below is a mapped type keyed by the `type` discriminant, so
//      it REQUIRES exactly one entry per variant. Add a new WireMsg/ClientMsg
//      type without a fixture → the map is missing a key → tsc errors. Rename
//      or retype an existing on-wire field → the fixture that still names the
//      old field no longer satisfies the variant → tsc errors. Adding a
//      message type therefore means adding a NEW fixture and touches no
//      existing one; changing a shape is impossible without breaking the build.
//
//   2. RUNTIME (enforced by `yarn test`). Every fixture is pure JSON (survives
//      a serialize→parse round-trip byte-for-byte — no `undefined`/function
//      drift that would corrupt a frame on the wire), its runtime `type`
//      matches the key it is filed under, and the load-bearing nested shapes
//      (agents rows, a SessionMeta, the three Action kinds) and
//      security-sensitive frames carry their exact field names and values.
//
// Complement, not overlap, with R.4h (ws.test.ts / session.itest.ts): those
// pin how the ends treat messages they DON'T know (unknown types ignored,
// tolerant client prop schemas). This pins the exact shape of the ones that
// DO exist (Q.2).

// A SessionMeta fixture (the fleet row, 4.6) — its own type, referenced by the
// `sessions` frame and asserted for its exact key set below.
const SESSION_META: SessionMeta = {
  sessionId: "s1",
  name: "refactor the parser",
  cwd: "/home/u/proj",
  agent: "codex",
  model: "gpt-5-codex",
  status: "working",
  lastActivity: 1_720_000_000_000,
  viewports: 2,
};

// The complete Action vocabulary (Phase 2) — carried inside render props.
const ACTIONS: Action[] = [
  { kind: "prompt", text: "run the tests" },
  { kind: "tool", name: "Bash", args: { command: "ls" } },
  { kind: "state", op: "pin", renderId: "r1" },
];

// Extract<…, { type: T }> reaches through WireMsg's `& { seq?: number }`
// intersection, so each fixture is the exact body type (plus the optional seq).
type WireByType = { [T in WireMsg["type"]]: Extract<WireMsg, { type: T }> };
type ClientByType = { [T in ClientMsg["type"]]: Extract<ClientMsg, { type: T }> };

// One canonical sample per server→browser message. Missing a key = missing a
// fixture = compile error (see tooth #1).
const WIRE: WireByType = {
  text_delta: { type: "text_delta", text: "hello world" },
  prompt_options: {
    type: "prompt_options",
    options: [
      {
        trigger: "$",
        value: "$audit",
        label: "audit",
        description: "perform a defensive security audit",
        kind: "skill",
      },
    ],
  },
  status: { type: "status", state: "thinking", label: "pondering" },
  turn_end: { type: "turn_end" },
  error: { type: "error", message: "something broke" },
  render: { type: "render", component: "card", props: { title: "T" }, id: "r1" },
  picker: {
    type: "picker",
    id: "pk1",
    title: "Select a model",
    rows: [{ label: "gpt-9-sol", detail: "frontier", current: true, text: "/model gpt-9-sol" }],
    hint: "Send `/model <model-id>` to switch.",
  },
  tool_use: {
    type: "tool_use",
    name: "Bash",
    detail: "ls -la",
    id: "t1",
    input: { command: "ls -la" },
    parentId: "task1",
  },
  tool_result: {
    type: "tool_result",
    output: "file.txt",
    isError: false,
    id: "t1",
    truncatedBytes: 128,
    parentId: "task1",
  },
  permission_request: { type: "permission_request", tool: "Bash", detail: "rm -rf build", id: "p1" },
  permission_resolved: { type: "permission_resolved", id: "p1", allow: true },
  user_prompt: { type: "user_prompt", text: "do the thing" },
  session_created: {
    type: "session_created",
    sessionId: "s1",
    cwd: "/home/u/proj",
    agent: "claude-code",
    resumed: false,
    demo: false,
    fallback: false,
  },
  agents: {
    type: "agents",
    agents: [
      {
        agent: "claude-code",
        live: true,
        blocked: false,
        detail: "claude-sonnet-5",
        // N.3: the second-step menu — one of each backend flavor.
        backends: [
          { kind: "api-key", usable: true, detail: "claude-sonnet-5" },
          { kind: "subscription", usable: false, blocked: true },
          {
            kind: "local",
            usable: true,
            endpoint: "http://127.0.0.1:11434",
            runtime: "ollama",
            models: ["llama3.2:3b"],
          },
        ],
      },
    ],
    default: "claude-code",
    cwd: "/home/u/proj",
    home: "/home/u",
    folderPicker: true,
    relay: { url: "wss://relay.mirafold.sh", code: "abc123def456ghij" },
    version: "0.0.1",
  },
  folder_picked: { type: "folder_picked", id: "fp1", path: "/home/u/other-project" },
  refused: {
    type: "refused",
    reason: "subscription_over_relay",
    message: "This session's credential can't be used over the relay.",
  },
  artifact: { type: "artifact", html: "<p>hi</p>", id: "a1", title: "Chart" },
  usage: { type: "usage", model: "claude-sonnet-5", inputTokens: 100, outputTokens: 25, costUsd: 0.0123 },
  thinking_delta: { type: "thinking_delta", text: "let me think" },
  notice: { type: "notice", text: "API error — retrying (attempt 2/5)…", kind: "retry" },
  bang_start: { type: "bang_start", command: "npm test", id: "b1" },
  bang_output: { type: "bang_output", data: "PASS\n", id: "b1" },
  bang_end: { type: "bang_end", id: "b1", exitCode: 0 },
  pong: { type: "pong" },
  fs_tree: {
    type: "fs_tree",
    id: "f1",
    root: "/home/u/proj",
    entries: [{ path: "src/app.ts" }, { path: "README.md", status: "M" }],
    git: false,
    truncated: true,
    error: "the session workspace is not readable",
  },
  fs_dir: {
    type: "fs_dir",
    id: "f4",
    path: "src",
    entries: [
      { name: "components", kind: "dir" },
      { name: "app.ts", kind: "file", status: "M" },
      { name: "link", kind: "symlink" },
    ],
    truncated: true,
    error: "path is outside the session workspace",
  },
  fs_file: {
    type: "fs_file",
    id: "f2",
    path: "src/app.ts",
    content: "export {};\n",
    size: 11,
    truncatedBytes: 0,
    binary: false,
    error: "path is outside the session workspace",
  },
  fs_file_diff: {
    type: "fs_file_diff",
    id: "f3",
    path: "src/app.ts",
    before: "export {};\n",
    after: "export default {};\n",
    beforeTruncatedBytes: 0,
    afterTruncatedBytes: 0,
    binary: false,
    error: "no diff available for this entry",
  },
  fs_changed: {
    type: "fs_changed",
    paths: ["src/app.ts", ".git/index"],
    truncated: true,
  },
  sessions: { type: "sessions", sessions: [SESSION_META] },
  session_ended: { type: "session_ended", sessionId: "s1" },
};

// One canonical sample per browser→server message.
const CLIENT: ClientByType = {
  prompt: { type: "prompt", text: "hello" },
  interrupt: { type: "interrupt" },
  permission_response: { type: "permission_response", id: "p1", allow: true },
  attach: { type: "attach", sessionId: "s1", afterSeq: 42, clientVersion: "0.0.1" },
  create: {
    type: "create",
    cwd: "/home/u/proj",
    agent: "gemini-cli",
    clientVersion: "0.0.1",
    backend: { kind: "local", endpoint: "http://127.0.0.1:11434", model: "llama3.2:3b" },
  },
  action: { type: "action", action: { kind: "prompt", text: "go" }, sourceId: "r1" },
  bang: { type: "bang", command: "ls", id: "b1" },
  bang_input: { type: "bang_input", data: "hunter2\n", id: "b1" },
  bang_kill: { type: "bang_kill", id: "b1" },
  ping: { type: "ping" },
  watch_sessions: { type: "watch_sessions" },
  rename: { type: "rename", sessionId: "s1", name: "renamed" },
  end_session: { type: "end_session", sessionId: "s1" },
  // M.2: the cockpit's sessionId-addressed grid acts (the end_session precedent).
  answer_permission: { type: "answer_permission", sessionId: "s1", id: "p1", allow: true },
  interrupt_session: { type: "interrupt_session", sessionId: "s1" },
  prompt_session: { type: "prompt_session", sessionId: "s1", text: "run the tests" },
  refresh_agents: { type: "refresh_agents" },
  pick_folder: { type: "pick_folder", id: "fp1", cwd: "/home/u/proj" },
  fs_list: { type: "fs_list", id: "f1" },
  fs_listdir: { type: "fs_listdir", id: "f4", path: "src" },
  fs_read: { type: "fs_read", id: "f2", path: "src/app.ts" },
  fs_diff: { type: "fs_diff", id: "f3", path: "src/app.ts" },
  client_error: { type: "client_error", message: "TypeError: x is undefined", clientVersion: "0.0.1" },
};

// seq is the registry's additive per-broadcast stamp (4.4) — assignable onto
// any WireMsg. Compile-only proof it belongs to the wire shape; the fixtures
// above stay body-only because seq is the registry's to add, not the adapter's.
const _seqIsOnTheWire: WireMsg = { type: "turn_end", seq: 7 };
void _seqIsOnTheWire;

test("Q.2 every WireMsg fixture: discriminant matches its key, and it is pure JSON", () => {
  for (const [key, msg] of Object.entries(WIRE)) {
    assert.equal((msg as { type: string }).type, key, `fixture under "${key}" has the wrong type`);
    assert.deepEqual(
      JSON.parse(JSON.stringify(msg)),
      msg,
      `"${key}" is not wire-serializable as-is (undefined/function drift)`,
    );
  }
});

test("Q.2 every ClientMsg fixture: discriminant matches its key, and it is pure JSON", () => {
  for (const [key, msg] of Object.entries(CLIENT)) {
    assert.equal((msg as { type: string }).type, key, `fixture under "${key}" has the wrong type`);
    assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg, `"${key}" is not wire-serializable as-is`);
  }
});

test("Q.2 nested shapes carry their exact field names", () => {
  // agents row + relay pairing block (R.4 — the deliberately user-facing one).
  assert.deepEqual(WIRE.agents.agents[0], {
    agent: "claude-code",
    live: true,
    blocked: false,
    detail: "claude-sonnet-5",
    backends: [
      { kind: "api-key", usable: true, detail: "claude-sonnet-5" },
      { kind: "subscription", usable: false, blocked: true },
      {
        kind: "local",
        usable: true,
        endpoint: "http://127.0.0.1:11434",
        runtime: "ollama",
        models: ["llama3.2:3b"],
      },
    ],
  });
  assert.deepEqual(WIRE.agents.relay, { url: "wss://relay.mirafold.sh", code: "abc123def456ghij" });
  // SessionMeta — the fleet row's exact key set.
  assert.deepEqual(Object.keys(SESSION_META).sort(), [
    "agent",
    "cwd",
    "lastActivity",
    "model",
    "name",
    "sessionId",
    "status",
    "viewports",
  ]);
  // The three Action kinds, in vocabulary order.
  assert.deepEqual(
    ACTIONS.map((a) => a.kind),
    ["prompt", "tool", "state"],
  );
});

// M.1: the cockpit's enriched fleet row — every Phase M optional field
// populated. Pinned as its OWN fixture so SESSION_META above stays minimal
// and keeps proving the new fields are optional (an old daemon's row still
// typechecks and round-trips).
const COCKPIT_META: SessionMeta = {
  ...SESSION_META,
  createdAt: 1_719_999_000_000,
  activity: { label: "Bash", since: 1_720_000_000_500 },
  permissions: [{ id: "p1", tool: "Bash", detail: "rm -rf build" }],
  usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.05 },
};

test("M.1 the enriched fleet row: exact key set, pure JSON", () => {
  assert.deepEqual(Object.keys(COCKPIT_META).sort(), [
    "activity",
    "agent",
    "createdAt",
    "cwd",
    "lastActivity",
    "model",
    "name",
    "permissions",
    "sessionId",
    "status",
    "usage",
    "viewports",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(COCKPIT_META)), COCKPIT_META);
});

test("Q.2 load-bearing frames keep their exact shape (a rename fails here loudly)", () => {
  assert.deepEqual(WIRE.render, { type: "render", component: "card", props: { title: "T" }, id: "r1" });
  assert.deepEqual(WIRE.notice, {
    type: "notice",
    text: "API error — retrying (attempt 2/5)…",
    kind: "retry",
  });
  // Security-sensitive: the permission round-trip and the ephemeral bang stdin
  // (the never-broadcast secret path) must not silently change field names.
  assert.deepEqual(CLIENT.permission_response, { type: "permission_response", id: "p1", allow: true });
  assert.deepEqual(CLIENT.bang_input, { type: "bang_input", data: "hunter2\n", id: "b1" });
  assert.deepEqual(CLIENT.pick_folder, { type: "pick_folder", id: "fp1", cwd: "/home/u/proj" });
  assert.deepEqual(WIRE.folder_picked, {
    type: "folder_picked",
    id: "fp1",
    path: "/home/u/other-project",
  });
});
