import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startDaemon, TestClient, type Daemon } from "../testing/itest-harness";

// The 4.5 auth gate over real HTTP and a real ws handshake. The token
// gates both surfaces; `?token=` mints the SameSite cookie then redirects (L.2b).

const TOKEN = "itest-token-4a1b";
let d: Daemon;

before(async () => {
  d = await startDaemon({ MIRAFOLD_TOKEN: TOKEN });
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

test("strict port mode refuses a collision instead of leaving a fixed proxy behind", async () => {
  await assert.rejects(
    startDaemon({ PORT: String(d.port), MIRAFOLD_STRICT_PORT: "1" }),
    (err: Error) => {
      assert.match(err.message, new RegExp(`port ${d.port} is already in use`));
      assert.match(err.message, /requires that exact port/);
      assert.doesNotMatch(err.message, /busy — trying/);
      assert.doesNotMatch(err.message, /server on http/);
      return true;
    },
  );
});

test("HTTP: valid ?token= mints the cookie and redirects to the clean path", async () => {
  const res = await http(`/?token=${TOKEN}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`mirafold_token=${TOKEN}`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test("HTTP: valid cookie passes the gate", async () => {
  const res = await http("/", { headers: { cookie: `mirafold_token=${TOKEN}` } });
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
  const c = new TestClient(d.port, { cookie: `mirafold_token=${TOKEN}` });
  await c.opened();
  await c.type("agents");
  c.close();
});

test("WS: a foreign Origin is rejected even with a valid token", async () => {
  await assert.rejects(
    new TestClient(d.port, { token: TOKEN, origin: "https://evil.example" }).opened(),
  );
});

test("WS: our OWN origin (the browser case) is accepted", async () => {
  const c = new TestClient(d.port, { token: TOKEN, origin: `http://127.0.0.1:${d.port}` });
  await c.opened();
  c.close();
});

test("WS: another loopback port is rejected even with a valid token (2026-07-27 audit)", async () => {
  // The cross-origin-localhost hijack: a page served from any other local
  // port (another dev server, a hostile postinstall's server) is same-site
  // with us — cookie scope ignores ports — so the browser would attach our
  // auth cookie to its handshake and the socket drives a shell as the user.
  await assert.rejects(
    new TestClient(d.port, { token: TOKEN, origin: `http://127.0.0.1:${d.port + 1}` }).opened(),
  );
  await assert.rejects(
    new TestClient(d.port, { token: TOKEN, origin: "http://localhost:5173" }).opened(),
  );
});

// SECURITY.md: with the token disabled "the daemon says so loudly at boot".
// Four suites boot with MIRAFOLD_TOKEN="" and none read the log, so the
// warning could vanish unnoticed (test-audit 2026-08-26).
test("auth off: the boot log carries the AUTH DISABLED warning, and the page is served without a token", async () => {
  const open = await startDaemon({ MIRAFOLD_TOKEN: "" });
  try {
    // stderr, not the stdout ready line startDaemon waits on — so wait for
    // it the way the harness documents (cold review 2026-08-26).
    await open.waitForLog(/AUTH DISABLED/, "the loud auth-off warning");
    const res = await fetch(`http://127.0.0.1:${open.port}/`);
    assert.equal(res.status, 200, "auth is really off — the shell is served with no token");
  } finally {
    await open.stop();
  }
});
