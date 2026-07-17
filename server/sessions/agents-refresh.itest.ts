import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startDaemon, TestClient, type Daemon } from "../testing/itest-harness";
import type { AgentBackend, AgentName, WireMsg } from "../protocol";

// N.3 against the real daemon: a fixture "ollama" reaches the hello's
// `backends` dialect-filtered per agent, and the refresh_agents round-trip
// makes it appear/disappear live — the picker's "start it and it appears
// here" promise, observed over a real socket. The harness forces
// MIRAFOLD_LOCAL_DISCOVERY=off, so the ONLY probe target is our fixture:
// a real Ollama on the dev machine can't leak in.

type AgentsMsg = Extract<WireMsg, { type: "agents" }>;

const OLLAMA_TAGS = JSON.stringify({ models: [{ name: "llama3.2:3b" }] });

// The fixture serves /api/tags (the Ollama fingerprint) while `up` — flipping
// it simulates the user stopping their local server between refreshes.
let up = true;
const fixture = http.createServer((req, res) => {
  if (!up || req.url !== "/api/tags") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(OLLAMA_TAGS);
});

let origin = "";
let daemon: Daemon;

const backendsOf = (msg: WireMsg, agent: AgentName): AgentBackend[] | undefined =>
  (msg as AgentsMsg).agents.find((a) => a.agent === agent)?.backends;

after(async () => {
  fixture.close();
  await daemon?.stop();
});

test("N.3: a running local server appears in `backends` (dialect-filtered) and disappears on refresh after it stops", async () => {
  await new Promise<void>((resolve) => {
    fixture.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
      resolve();
    });
  });
  // Fast refresh window so the second refresh actually re-probes.
  daemon = await startDaemon({
    MIRAFOLD_LOCAL_ENDPOINTS: origin,
    REFRESH_MIN_INTERVAL_MS: "50",
  });

  const client = new TestClient(daemon.port);
  await client.opened();
  // The connect-time hello may or may not carry the fixture (the startup
  // probe races the first hello — by design; startup never waits on it).
  await client.type("agents");

  // Refresh → re-probe → the fixture server is in every dialect-compatible
  // agent's menu, absent from gemini's.
  client.send({ type: "refresh_agents" });
  const refreshed = await client.waitFor(
    (m) => m.type === "agents" && backendsOf(m, "claude-code")?.some((b) => b.runtime === "ollama") === true,
    "agents with the fixture ollama",
  );
  const claude = backendsOf(refreshed, "claude-code")!.find((b) => b.runtime === "ollama")!;
  assert.equal(claude.kind, "local");
  assert.equal(claude.usable, true);
  assert.equal(claude.endpoint, origin);
  assert.deepEqual(claude.models, ["llama3.2:3b"]);
  assert.ok(
    backendsOf(refreshed, "codex")?.some((b) => b.runtime === "ollama"),
    "ollama speaks the openai dialect too — codex's menu carries it",
  );
  assert.ok(
    !backendsOf(refreshed, "gemini-cli")?.some((b) => b.runtime === "ollama"),
    "gemini has no BYO-endpoint path — never a local row",
  );

  // Stop the server; the next refresh (past the throttle window) drops it.
  up = false;
  await new Promise((r) => setTimeout(r, 100));
  client.send({ type: "refresh_agents" });
  await client.waitFor(
    (m) =>
      m.type === "agents" && backendsOf(m, "claude-code")?.some((b) => b.runtime === "ollama") !== true,
    "agents without the stopped server",
  );
  client.close();
});
