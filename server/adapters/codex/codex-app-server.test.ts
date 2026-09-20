import { test } from "node:test";
import assert from "node:assert/strict";
import { AppServerRpcError, spawnAppServer } from "./codex-app-server";

test("native RPC errors retain their code so unsupported methods differ from failed updates", async () => {
  const client = spawnAppServer({ command: process.execPath, args: ["-e", `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, error:{code:-32601,message:'Method not found'}})+'\\n');
    });
  `] });
  try {
    await assert.rejects(client.request("thread/inject_items"), (error) =>
      error instanceof AppServerRpcError && error.code === -32601 && error.message === "Method not found");
  } finally { client.kill(); }
});

test("an oversized app-server line is rejected without a quadratic buffer stall", async () => {
  const started = Date.now();
  const client = spawnAppServer({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("x".repeat(32 * 1024 * 1024 + 1))'],
  });

  await assert.rejects(client.request("probe"), /size limit/);

  assert.ok(Date.now() - started < 5_000, "the ceiling fires promptly");
  assert.match(client.stderrTail, /size limit/);
});
