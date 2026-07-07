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
