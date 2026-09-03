import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ConfigEnv, UserConfig } from "vite";
import makeViteConfig from "../../vite.config";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

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

test("yarn dev exits before Vite starts when the selected daemon port is occupied", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = blocker.address();
    assert.ok(address && typeof address !== "string");

    await assert.rejects(
      execFileAsync("yarn", ["dev"], {
        cwd: projectRoot,
        env: {
          ...process.env,
          MIRAFOLD_NO_OPEN: "1",
          PORT: String(address.port),
        },
        timeout: 10_000,
      }),
      (error: Error & { code?: number | string; stdout?: string; stderr?: string }) => {
        const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
        assert.equal(error.code, 1);
        assert.match(output, new RegExp(`port ${address.port} is already in use`));
        assert.doesNotMatch(output, /VITE v/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
