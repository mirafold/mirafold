import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnAppServer } from "./codex-app-server";

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
