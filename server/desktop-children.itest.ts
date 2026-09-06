import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitFor } from "./testing/wait-for";
import {
  desktopDaemon, fixtureFiles, assertDesktopSecretAbsent,
  DESKTOP_TEST_KEY as KEY, DESKTOP_TEST_AMBIENT as AMBIENT,
} from "./testing/desktop-harness";

const FIXTURES = path.resolve(import.meta.dirname, "testing/fixtures");
const observer = path.join(FIXTURES, "desktop-observer.mjs");
const engine = path.join(FIXTURES, "desktop-engine.mjs");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
type Observation = {
  label: string; pid: number; ppid: number; envKeys: string[]; privatePipeOpen: boolean;
  envHashes: string[]; argvHashes: string[]; osEnvHashes: string[]; osArgvHashes: string[];
};

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-desktop-children-"));
  const bin = path.join(root, "bin");
  const cwd = path.join(root, "workspace");
  const capture = path.join(root, "capture");
  mkdirSync(bin); mkdirSync(cwd); mkdirSync(capture);
  const trust = path.join(root, "trust.json");
  writeFileSync(trust, JSON.stringify({ version: 2, scopes: Object.fromEntries(["claude-code", "codex", "gemini-cli", "opencode"].map((agent) => [agent, [cwd]])) }));
  for (const agent of ["codex", "gemini", "opencode"]) {
    writeFileSync(path.join(bin, agent), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(engine)} ${agent} "$@"\n`, { mode: 0o755 });
  }
  const reports = (): Observation[] => fixtureFiles(capture)
    .filter((file) => !path.basename(file).startsWith("mcp-ack-"))
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as Observation);
  t.after(() => {
    // Last resort for a failed assertion: only pids this fixture recorded.
    for (const report of reports()) {
      try { process.kill(report.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, bin, cwd, capture, reports, env: {
    MIRAFOLD_TEST_CAPTURE: capture,
    MIRAFOLD_TEST_DAEMON_OBSERVER: "1",
    MIRAFOLD_CODEX_BIN: path.join(bin, "codex"),
    MIRAFOLD_GEMINI_BIN: path.join(bin, "gemini"),
    OPENCODE_BIN: path.join(bin, "opencode"),
  } };
}

const LINUX = process.platform === "linux" ? false : "Linux process metadata and stdin identity proof";
for (const [agent, mode, credential] of [
  ["claude-code", "claude", "ANTHROPIC_API_KEY"],
  ["codex", "codex", "OPENAI_API_KEY"],
  ["gemini-cli", "gemini", "GEMINI_API_KEY"],
  ["opencode", "opencode", ""],
] as const) {
  test(`DA.3: ${agent} and its reachable MCP children cannot inherit the private input or daemon credentials`, { skip: LINUX }, async (t) => {
    const f = fixture(t);
    const run = await desktopDaemon(t, { root: f.root, imports: [observer], env: {
      ...f.env,
      ...(credential ? { [credential]: "fixture-provider-credential" } : {}),
      MIRAFOLD_LICENSE_KEY: AMBIENT,
      MIRAFOLD_RELAY_URL: "off",
      MIRAFOLD_TOKEN: "fixture-daemon-authentication",
      MIRAFOLD_RELAY_CODE: "fixture-pairing-code",
    } });
    run.client.send({ type: "create", agent, cwd: f.cwd,
      ...(agent === "opencode" ? {} : { backend: { kind: "api-key", model: "fixture" } }),
    });
    const created = await run.client.waitFor((message) => message.type === "session_created" || message.type === "error", "session creation");
    assert.equal(created.type, "session_created", JSON.stringify(created).replaceAll(KEY, "[private key]").replaceAll(AMBIENT, "[ambient key]"));
    run.client.send({ type: "prompt", text: "exercise the child boundary" });
    await waitFor(() => f.reports().some((report) => report.label === `${mode}-engine`), `${agent} real child observed`, 15_000,
      () => f.reports().map((report) => report.label).join(","));
    await run.client.type("error", 15_000);
    if (agent !== "claude-code") {
      await waitFor(() => fixtureFiles(f.capture).some((file) => path.basename(file).startsWith(`mcp-ack-${mode}-`)), `${agent} real MCP acknowledgement`, 10_000);
      assert.ok(f.reports().some((report) => report.label === "mcp"));
    }
    if (agent === "codex" || agent === "gemini-cli") {
      run.client.send({ type: "prompt", text: "/model" });
      await waitFor(() => f.reports().some((report) => report.label === `${mode}-catalog`), `${agent} catalog child observed`, 10_000);
    }
    await run.stop();
    const reports = f.reports();
    assert.ok(reports.some((report) => report.label === "daemon-after-private-read"));
    for (const report of reports) {
      assert.equal(report.privatePipeOpen, false, `${report.label} kept the private descriptor`);
      for (const source of [report.envHashes, report.argvHashes, report.osEnvHashes, report.osArgvHashes]) {
        assert.ok(!source.includes(hash(KEY)), `${report.label} received the private key`);
        if (report.label !== "daemon-after-private-read") assert.ok(!source.includes(hash(AMBIENT)), `${report.label} inherited the ambient license`);
      }
      if (report.label !== "daemon-after-private-read") assert.deepEqual(report.envKeys, [], `${report.label} inherited daemon-only environment fields`);
    }
    assertDesktopSecretAbsent(run, [KEY, AMBIENT]);
  });
}

test("DA.3: an official Desktop launch keeps the key out of a real PTY, transcript, and checkpoint", { skip: LINUX }, async (t) => {
  const f = fixture(t);
  const run = await desktopDaemon(t, { root: f.root, imports: [observer], env: {
    ...f.env, OPENCODE_BIN: path.join(f.bin, "missing-opencode"), MIRAFOLD_RELAY_URL: "off",
  } });
  run.client.send({ type: "create", agent: "claude-code", cwd: f.cwd });
  await run.client.type("session_created");
  run.client.send({ type: "bang", id: "desktop-pty", command: `${shellQuote(process.execPath)} ${shellQuote(engine)} pty` });
  await run.client.type("bang_end");
  assert.ok(run.client.received.some((message) => message.type === "bang_output" && message.data.includes("Desktop child probe")));
  const report = f.reports().find((report) => report.label === "pty-engine");
  assert.ok(report, "the real PTY child must run");
  assert.equal(report.privatePipeOpen, false);
  assert.deepEqual(report.envHashes, []);
  assert.deepEqual(report.osEnvHashes, []);
  assert.deepEqual(report.argvHashes, []);
  assert.deepEqual(report.osArgvHashes, []);
  await run.stop();
  assert.ok(fixtureFiles(path.join(f.root, "sessions")).length > 0, "the transcript must actually have been persisted");
  assertDesktopSecretAbsent(run);
});
