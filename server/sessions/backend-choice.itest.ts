import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { startDaemon, TestClient, type Daemon } from "../testing/itest-harness";
import type { ClientMsg, WireMsg } from "../protocol";

// N.5 against the real daemon: the create.backend choice is honored (the log
// names the resolved backend; a local pick's model label reaches
// session_created on the wire) and NEVER trusted (a prohibited or stale
// choice refuses with an error frame, no session). Codex only on the live
// paths — its engine constructs lazily (no process, no network until a turn),
// so creating sessions here stays hermetic; claude exercises refusal only.

const OLLAMA_TAGS = JSON.stringify({ models: [{ name: "llama3.2:3b" }] });
const fixture = http.createServer((req, res) => {
  if (req.url !== "/api/tags") {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(OLLAMA_TAGS);
});

let origin = "";
let daemon: Daemon;
let codexDir = "";
let claudeDir = "";

before(async () => {
  await new Promise<void>((resolve) => {
    fixture.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
      resolve();
    });
  });
  codexDir = mkdtempSync(path.join(os.tmpdir(), "genui-n5-codex-"));
  writeFileSync(path.join(codexDir, "auth.json"), "{}");
  claudeDir = mkdtempSync(path.join(os.tmpdir(), "genui-n5-claude-"));
  writeFileSync(path.join(claudeDir, ".credentials.json"), "{}");
  daemon = await startDaemon({
    OPENAI_API_KEY: "sk-dummy",
    CODEX_HOME: codexDir,
    CLAUDE_CONFIG_DIR: claudeDir,
    MIRAFOLD_LOCAL_ENDPOINTS: origin,
    REFRESH_MIN_INTERVAL_MS: "50",
  });
});

after(async () => {
  fixture.close();
  await daemon?.stop();
  rmSync(codexDir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
});

async function openClient(): Promise<TestClient> {
  const client = new TestClient(daemon.port);
  await client.opened();
  await client.type("agents");
  return client;
}

test("N.5: opposite codex choices are honored — the daemon logs each resolved backend", async () => {
  const client = await openClient();
  client.send({ type: "create", agent: "codex", backend: { kind: "subscription" } } as ClientMsg);
  await client.type("session_created");
  assert.match(daemon.logs(), /create → codex on chosen backend subscription/);

  const client2 = await openClient();
  client2.send({ type: "create", agent: "codex", backend: { kind: "api-key" } } as ClientMsg);
  await client2.type("session_created");
  assert.match(daemon.logs(), /create → codex on chosen backend api-key/);
  client.close();
  client2.close();
});

test("N.5: a forged prohibited choice refuses — error frame, no session", async () => {
  const client = await openClient();
  const mark = client.mark();
  client.send({
    type: "create",
    agent: "claude-code",
    backend: { kind: "subscription" },
  } as ClientMsg);
  const err = (await client.type("error")) as WireMsg & { message: string };
  assert.match(err.message, /isn't available/);
  assert.ok(
    !client.received.slice(mark).some((m) => m.type === "session_created"),
    "a refused choice must not create a session",
  );
  client.close();
});

test("N.5: a discovered-server pick rides to the engine — the picked model IS the session's label", async () => {
  const client = await openClient();
  // Make sure the daemon has probed the fixture (startup probe races the
  // first hello by design).
  client.send({ type: "refresh_agents" } as ClientMsg);
  await client.waitFor(
    (m) =>
      m.type === "agents" &&
      m.agents.some((a) => a.backends?.some((b) => b.endpoint === origin)),
    "fixture server discovered",
  );
  client.send({
    type: "create",
    agent: "codex",
    backend: { kind: "local", endpoint: origin, model: "llama3.2:3b" },
  } as ClientMsg);
  const created = (await client.type("session_created")) as WireMsg & { model?: string };
  assert.equal(created.model, "llama3.2:3b"); // wire-observable proof of the pick
  assert.match(daemon.logs(), new RegExp(`chosen backend local @ ${origin} \\(llama3\\.2:3b\\)`));
  client.close();
});

test("N.5: a stale local pick (server gone) refuses instead of silently falling back", async () => {
  const client = await openClient();
  client.send({
    type: "create",
    agent: "codex",
    backend: { kind: "local", endpoint: "http://127.0.0.1:9", model: "x" },
  } as ClientMsg);
  const err = (await client.type("error")) as WireMsg & { message: string };
  assert.match(err.message, /no longer running/);
  client.close();
});
