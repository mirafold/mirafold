import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { jsonRpcOneShot } from "./jsonrpc-oneshot";

// Mirror of jsonrpc-oneshot.ts's provider-output ceiling. A literal keeps the
// regression capable of proving that removing the production cap is a failure.
const ONE_SHOT_STDOUT_MAX_BYTES = 1_000_000;

test("a child closing stdin rejects the lookup instead of crashing the process", () => {
  const moduleUrl = new URL("./jsonrpc-oneshot.ts", import.meta.url).href;
  const probe = `
    import { jsonRpcOneShot } from ${JSON.stringify(moduleUrl)};

    const command = process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : "/usr/bin/false";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "exit 1"] : [];

    await jsonRpcOneShot({
      command,
      args,
      timeoutMs: 2_000,
      label: "closed-stdin probe",
      start: (send) => send({ probe: true }),
      onMessage: () => {},
    }).catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 50));
    process.stdout.write("survived");
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", probe],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );

  assert.equal(
    result.status,
    0,
    `one-shot probe crashed\n${result.error?.stack ?? result.stderr}`,
  );
  assert.equal(result.stdout, "survived");
});

test("AUDIT: provider stdout is byte-capped before JSON buffering", async () => {
  const script = `
    process.stdout.write(Buffer.alloc(${ONE_SHOT_STDOUT_MAX_BYTES + 1}, 120));
    setInterval(() => {}, 1_000);
  `;

  await assert.rejects(
    jsonRpcOneShot({
      command: process.execPath,
      args: ["--eval", script],
      timeoutMs: 2_000,
      label: "oversized-stdout probe",
      start: () => {},
      onMessage: () => {},
    }),
    /oversized-stdout probe: stdout exceeded 1000000 bytes/,
  );
});

test("provider stdout accepts a valid response exactly at the byte ceiling", async () => {
  const script = `
    const prefix = '{"id":1,"result":"';
    const suffix = '"}\\n';
    const padding = "x".repeat(${ONE_SHOT_STDOUT_MAX_BYTES} - Buffer.byteLength(prefix + suffix));
    process.stdout.write(prefix + padding + suffix);
    setInterval(() => {}, 1_000);
  `;

  const result = await jsonRpcOneShot({
    command: process.execPath,
    args: ["--eval", script],
    timeoutMs: 2_000,
    label: "boundary-stdout probe",
    start: () => {},
    onMessage: (message, _send, finish) => {
      if ((message as { id?: unknown }).id === 1) finish(null, true);
    },
  });

  assert.equal(result, true);
});
