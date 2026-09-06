import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DESKTOP_CREDENTIAL_FLAG } from "./desktop-credential";
import type { WireMsg } from "./protocol";
import { SCRUBBED_CREDENTIAL_ENV, TestClient } from "./testing/itest-harness";

const KEY = `mf_${"c".repeat(26)}`;
const AMBIENT = `mf_${"d".repeat(26)}`;

async function daemon(t: TestContext, options: {
  input?: string;
  eof?: boolean;
  desktop?: boolean;
  env?: Record<string, string>;
} = {}) {
  // A fresh working directory keeps the real daemon away from any checkout
  // dotenv file, and every persistent test record stays in this fixture.
  const cwd = mkdtempSync(path.join(os.tmpdir(), "mirafold-desktop-startup-"));
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../dist-server/index.js"),
    ...(options.desktop === false ? [] : [DESKTOP_CREDENTIAL_FLAG])], {
    cwd,
    env: {
      PATH: process.env.PATH,
      ...SCRUBBED_CREDENTIAL_ENV,
      PORT: String(39_000 + Math.floor(Math.random() * 1_000)),
      MIRAFOLD_AGENT: "claude-code",
      MIRAFOLD_SESSION_DIR: path.join(cwd, "sessions"),
      MIRAFOLD_LICENSE_KEY: "",
      MIRAFOLD_ENTITLEMENT_TOKEN: "",
      MIRAFOLD_ENTITLEMENT_URL: "",
      MIRAFOLD_APP_URL: "",
      MIRAFOLD_LOCAL_DISCOVERY: "off",
      MIRAFOLD_LOCAL_ENDPOINTS: "",
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += String(chunk); });
  child.stderr.on("data", (chunk) => { logs += String(chunk); });
  child.stdin.on("error", () => {});
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await closed;
      clearTimeout(timer);
    }
    rmSync(cwd, { recursive: true, force: true });
  });
  if (options.eof === false) child.stdin.write(options.input ?? "");
  else child.stdin.end(options.input ?? "");
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("built daemon did not start in 15 seconds"));
    }, 15_000);
    const poll = setInterval(() => {
      const match = logs.match(/server on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(Number(match[1]));
      }
    }, 20);
    child.once("exit", () => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error("built daemon exited before listening"));
    });
  });
  const client = new TestClient(port);
  t.after(() => client.close());
  await client.opened();
  const hello = await client.type("agents") as Extract<WireMsg, { type: "agents" }>;
  return { cwd, client, hello, logs: () => logs };
}

test("built daemon uses the private key for local billing, warns once about an ambient key, and keeps explicit relay opt-out", async (t) => {
  const keys: string[] = [];
  const billing = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    keys.push(JSON.parse(body).licenseKey);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "active" }));
  });
  billing.listen(0, "127.0.0.1");
  await once(billing, "listening");
  t.after(() => new Promise<void>((resolve) => billing.close(() => resolve())));
  const address = billing.address();
  assert.ok(address && typeof address === "object");
  const run = await daemon(t, { input: KEY, env: {
    MIRAFOLD_LICENSE_KEY: AMBIENT,
    MIRAFOLD_RELAY_URL: "off",
    MIRAFOLD_ENTITLEMENT_URL: `http://127.0.0.1:${address.port}/api/entitlement`,
  } });
  assert.equal(run.hello.host, "desktop");
  assert.equal(run.hello.relayOff, "opt-out");
  assert.equal(run.hello.billing, "license-key");
  run.client.send({ type: "subscription_status", id: "status" });
  const response = await run.client.type("subscription");
  assert.equal(response.type === "subscription" && response.status, "active");
  assert.deepEqual(keys, [KEY]);
  assert.equal(run.logs().match(/ambient key is ignored/g)?.length, 1);
  assert.ok(!run.logs().includes(KEY) && !run.logs().includes(AMBIENT));
  assert.ok(!JSON.stringify(run.client.received).includes(KEY));
});

test("malformed, missing, oversized, and unterminated Desktop input preserve real local mock sessions", async (t) => {
  for (const options of [
    { input: `${KEY}\n` },
    { input: "" },
    { input: "x".repeat(100_000) },
    { input: KEY, eof: false },
  ]) {
    await t.test(options.eof === false ? "missing EOF" : `input length ${options.input.length}`, async (t) => {
      const run = await daemon(t, { ...options, env: { MIRAFOLD_LICENSE_KEY: AMBIENT } });
      assert.equal(run.hello.host, "desktop");
      assert.equal(run.hello.relay, undefined);
      assert.equal(run.hello.relayOff, "unentitled");
      assert.equal(run.hello.billing, undefined);
      run.client.send({ type: "create", agent: "claude-code", cwd: run.cwd });
      await run.client.type("session_created");
      run.client.send({ type: "prompt", text: "hello" });
      await run.client.type("turn_end");
      assert.ok(run.client.received.some((message) => message.type === "text_delta"));
      assert.match(run.logs(), /Desktop Pro credential unavailable/);
      assert.ok(!run.logs().includes(KEY) && !run.logs().includes(AMBIENT));
      assert.ok(!JSON.stringify(run.client.received).includes(KEY));
    });
  }
});

test("ordinary built-daemon startup never waits for pipe EOF and retains its existing license-key mode", async (t) => {
  const run = await daemon(t, { desktop: false, input: KEY, eof: false, env: {
    MIRAFOLD_RELAY_URL: "off",
    MIRAFOLD_LICENSE_KEY: AMBIENT,
  } });
  assert.equal(Object.hasOwn(run.hello, "host"), false);
  assert.equal(run.hello.billing, "license-key");
  assert.equal(run.hello.relayOff, "opt-out");
  assert.ok(!run.logs().includes("Desktop Pro"));
  assert.ok(!run.logs().includes(KEY) && !run.logs().includes(AMBIENT));
});
