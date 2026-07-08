import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startDaemon, TestClient, type Daemon } from "./itest-harness";

// L.2b: the 4.5 auth gate over real HTTP and a real ws handshake. The token
// gates both surfaces; `?token=` mints the SameSite cookie then redirects.

const TOKEN = "itest-token-4a1b";
let d: Daemon;

before(async () => {
  d = await startDaemon({ GENUI_TOKEN: TOKEN });
});
after(async () => {
  await d.stop();
});

const http = (path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${d.port}${path}`, { redirect: "manual", ...init });

test("HTTP: no token → 403; wrong token → 403", async () => {
  assert.equal((await http("/")).status, 403);
  assert.equal((await http("/?token=wrong")).status, 403);
});

test("HTTP: the 403 body names the recovery, not just the denial (R.4b)", async () => {
  const body = await (await http("/")).text();
  assert.match(body, /\?token=/);
  assert.match(body, /terminal/i);
});

test("EADDRINUSE walk: only the bound port says 'server on' (R.4b)", async () => {
  // Collide on purpose: a second daemon asked for the first one's port.
  const d2 = await startDaemon({ PORT: String(d.port) });
  try {
    assert.notEqual(d2.port, d.port); // it walked
    const serverOn = d2.logs().match(/server on http:\/\/127\.0\.0\.1:(\d+)\//g) ?? [];
    assert.equal(serverOn.length, 1, `expected one 'server on' line, got: ${serverOn}`);
    assert.match(serverOn[0], new RegExp(`:${d2.port}/`));
    assert.match(d2.logs(), new RegExp(`:${d.port} busy — trying :${d.port + 1}`));
  } finally {
    await d2.stop();
  }
});

test("HTTP: valid ?token= mints the cookie and redirects to the clean path", async () => {
  const res = await http(`/?token=${TOKEN}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`genui_token=${TOKEN}`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test("HTTP: valid cookie passes the gate", async () => {
  const res = await http("/", { headers: { cookie: `genui_token=${TOKEN}` } });
  assert.notEqual(res.status, 403);
});

test("WS: rejected without a token, and with a wrong one", async () => {
  await assert.rejects(new TestClient(d.port).opened());
  await assert.rejects(new TestClient(d.port, { token: "wrong" }).opened());
});

test("WS: accepted via ?token= — agents hello arrives", async () => {
  const c = new TestClient(d.port, { token: TOKEN });
  await c.opened();
  await c.type("agents");
  c.close();
});

test("WS: accepted via cookie", async () => {
  const c = new TestClient(d.port, { cookie: `genui_token=${TOKEN}` });
  await c.opened();
  await c.type("agents");
  c.close();
});

test("WS: a foreign Origin is rejected even with a valid token", async () => {
  await assert.rejects(
    new TestClient(d.port, { token: TOKEN, origin: "https://evil.example" }).opened(),
  );
});

test("WS: a loopback Origin (the browser case) is accepted", async () => {
  const c = new TestClient(d.port, { token: TOKEN, origin: "http://127.0.0.1:5173" });
  await c.opened();
  c.close();
});
