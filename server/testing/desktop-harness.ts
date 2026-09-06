import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import type { WireMsg } from "../protocol";
import { DESKTOP_CREDENTIAL_FLAG } from "../desktop-credential";
import { SCRUBBED_CREDENTIAL_ENV, TestClient } from "./itest-harness";
import { waitFor } from "./wait-for";

export const DESKTOP_TEST_KEY = `mf_${"e".repeat(26)}`;
export const DESKTOP_TEST_AMBIENT = `mf_${"f".repeat(26)}`;
export const DAEMON_ENTRY = process.env.MIRAFOLD_TEST_DAEMON_ENTRY ?? path.resolve(import.meta.dirname, "../../dist-server/index.js");

export async function desktopDaemon(t: TestContext, options: {
  root?: string;
  chunks?: (string | Buffer)[];
  eof?: boolean;
  desktop?: boolean;
  ignoreStdin?: boolean;
  env?: Record<string, string>;
  imports?: string[];
} = {}) {
  const root = options.root ?? mkdtempSync(path.join(os.tmpdir(), "mirafold-desktop-boundary-"));
  const cwd = path.join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    ...SCRUBBED_CREDENTIAL_ENV,
    SHELL: "/bin/sh",
    CODEX_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    PORT: String(39_000 + Math.floor(Math.random() * 1_000)),
    MIRAFOLD_DEBUG: "1",
    MIRAFOLD_LOG_FILE: path.join(root, "logs", "daemon.log"),
    MIRAFOLD_SESSION_DIR: path.join(root, "sessions"),
    MIRAFOLD_WORKSPACE_TRUST_FILE: path.join(root, "trust.json"),
    MIRAFOLD_AGENT: "claude-code",
    MIRAFOLD_LICENSE_KEY: "",
    MIRAFOLD_ENTITLEMENT_TOKEN: "",
    MIRAFOLD_ENTITLEMENT_URL: "",
    MIRAFOLD_APP_URL: "",
    MIRAFOLD_LOCAL_DISCOVERY: "off",
    MIRAFOLD_LOCAL_ENDPOINTS: "",
    SUBSCRIPTION_MIN_GAP_MS: "0",
    ...options.env,
  };
  const child = spawn(process.execPath, [
    ...(options.imports ?? []).flatMap((file) => ["--import", file]),
    DAEMON_ENTRY,
    ...(options.desktop === false ? [] : [DESKTOP_CREDENTIAL_FLAG]),
  ], { cwd, env, stdio: [options.ignoreStdin ? "ignore" : "pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin?.on("error", () => {});
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const hard = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await closed;
      clearTimeout(hard);
    } else await closed;
  })();
  t.after(async () => {
    await stop();
    if (!options.root) rmSync(root, { recursive: true, force: true });
  });
  for (const chunk of options.chunks ?? [DESKTOP_TEST_KEY]) {
    child.stdin?.write(chunk);
    await delay(5);
  }
  if (options.eof !== false) child.stdin?.end();
  const logs = () => stdout + stderr;
  await waitFor(() => /server on http:\/\/127\.0\.0\.1:(\d+)\//.test(logs()), "Desktop daemon listening", 15_000,
    () => `exit ${child.exitCode}; signal ${child.signalCode}`);
  const port = Number(logs().match(/server on http:\/\/127\.0\.0\.1:(\d+)\//)![1]);
  const client = new TestClient(port, env.MIRAFOLD_TOKEN ? { token: env.MIRAFOLD_TOKEN } : {});
  t.after(() => client.close());
  await client.opened();
  const hello = await client.type("agents") as Extract<WireMsg, { type: "agents" }>;
  return { root, cwd, env, child, client, hello, port, stop, logs, stdout: () => stdout, stderr: () => stderr,
    waitLog: (pattern: RegExp) => waitFor(() => pattern.test(logs()), String(pattern), 15_000),
  };
}

export type DesktopDaemon = Awaited<ReturnType<typeof desktopDaemon>>;

export async function fakeDesktopBilling(t: TestContext, answer: (route: string, key: unknown) => {
  status?: number;
  body?: unknown;
  raw?: string;
  closeEarly?: boolean;
  stall?: boolean;
}) {
  const requests: { route: string; key: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let input = "";
    for await (const chunk of req) input += String(chunk);
    const key: unknown = JSON.parse(input).licenseKey;
    const route = req.url ?? "";
    requests.push({ route, key });
    const reply = answer(route, key);
    if (reply.closeEarly) { res.destroy(); return; }
    if (reply.stall) return;
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    // Deliberately split every response, including a reflected credential,
    // across transport chunks before the production bounded reader sees it.
    const body = reply.raw ?? JSON.stringify(reply.body);
    const chunkSize = body.length > 65_536 ? 4_093 : 7;
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      if (res.destroyed) return;
      res.write(body.slice(offset, offset + chunkSize));
      await delay(1);
    }
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, requests, url: `http://127.0.0.1:${address.port}/api/entitlement` };
}

// Even test-owned trees obey the account's dotenv opacity rule. Do not
// traverse symlinks or ever inspect an opaque filename's contents.
const opaque = (name: string) => name === ".env" || name.endsWith(".env") || name.startsWith(".env.") || name.includes(".env.");
export function fixtureFiles(root: string): string[] {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => !opaque(entry.name)).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? fixtureFiles(file) : entry.isFile() ? [file] : [];
  });
}

export function assertDesktopSecretAbsent(run: DesktopDaemon, secrets = [DESKTOP_TEST_KEY], messages: WireMsg[] = []) {
  const surfaces: [string, string][] = [
    ["stdout", run.stdout()], ["stderr", run.stderr()],
    ["local WireMsg", JSON.stringify(run.client.received)], ["remote WireMsg", JSON.stringify(messages)],
    ...fixtureFiles(run.root).map((file): [string, string] => [path.relative(run.root, file), readFileSync(file, "utf8")]),
  ];
  const leaks = surfaces.filter(([, text]) => secrets.some((secret) => text.includes(secret))).map(([name]) => name);
  assert.deepEqual(leaks, [], "credential reached these surfaces");
}
