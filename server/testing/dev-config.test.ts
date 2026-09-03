import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConfigEnv, UserConfig } from "vite";
import makeViteConfig from "../../vite.config";

test("the Vite WebSocket proxy follows the daemon PORT", async () => {
  assert.equal(typeof makeViteConfig, "function");
  const priorPort = process.env.PORT;
  process.env.PORT = "43123";
  try {
    const config = await (makeViteConfig as (env: ConfigEnv) => UserConfig)({
      command: "serve",
      mode: "test",
      isSsrBuild: false,
      isPreview: false,
    });
    const wsProxy = config.server?.proxy?.["/ws"];
    if (!wsProxy || typeof wsProxy === "string") {
      assert.fail("expected the /ws proxy to use an options object");
    }
    assert.equal(wsProxy.target, "ws://127.0.0.1:43123");
  } finally {
    if (priorPort === undefined) delete process.env.PORT;
    else process.env.PORT = priorPort;
  }
});

test("the Vite WebSocket proxy uses the daemon fallback for a malformed PORT", async () => {
  assert.equal(typeof makeViteConfig, "function");
  const priorPort = process.env.PORT;
  process.env.PORT = "not-a-port";
  try {
    const config = await (makeViteConfig as (env: ConfigEnv) => UserConfig)({
      command: "serve",
      mode: "test",
      isSsrBuild: false,
      isPreview: false,
    });
    const wsProxy = config.server?.proxy?.["/ws"];
    if (!wsProxy || typeof wsProxy === "string") {
      assert.fail("expected the /ws proxy to use an options object");
    }
    assert.equal(wsProxy.target, "ws://127.0.0.1:3000");
  } finally {
    if (priorPort === undefined) delete process.env.PORT;
    else process.env.PORT = priorPort;
  }
});
