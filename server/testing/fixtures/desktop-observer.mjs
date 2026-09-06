// Test-only observation around the unchanged built daemon / real MCP entry.
// Report hashes and descriptor identity, never credential bytes.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const capture = process.env.MIRAFOLD_TEST_CAPTURE;
const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
const link = (file) => { try { return fs.readlinkSync(file); } catch { return ""; } };
const hashes = (text) => [...text.matchAll(/mf_[a-z2-7]{20,40}/g)].map(([value]) => createHash("sha256").update(value).digest("hex"));
const daemonNames = ["MIRAFOLD_TOKEN", "MIRAFOLD_LICENSE_KEY", "MIRAFOLD_RELAY_CODE", "MIRAFOLD_ENTITLEMENT_TOKEN"];

export function observe(label) {
  if (!capture) throw new Error("Desktop probe has no capture directory");
  const links = process.platform === "linux"
    ? fs.readdirSync("/proc/self/fd").filter((name) => /^\d+$/.test(name)).map((name) => link(`/proc/self/fd/${name}`))
    : [];
  const report = {
    label, pid: process.pid, ppid: process.ppid,
    envKeys: daemonNames.filter((name) => Object.hasOwn(process.env, name)),
    envHashes: hashes(JSON.stringify(process.env)),
    argvHashes: hashes(JSON.stringify(process.argv)),
    osEnvHashes: hashes(read("/proc/self/environ")),
    osArgvHashes: hashes(read("/proc/self/cmdline")),
    privatePipeOpen: links.some((target) => target && target === process.env.MIRAFOLD_TEST_PIPE_TARGET),
  };
  fs.mkdirSync(capture, { recursive: true });
  fs.writeFileSync(path.join(capture, `${label}-${process.pid}.json`), JSON.stringify(report));
  return report;
}

if (process.env.MIRAFOLD_TEST_DAEMON_OBSERVER === "1") {
  // The preload runs before any daemon module. The first HTTP server creation
  // is after the private reader; identity must be gone even if fd 0 is reused.
  process.env.MIRAFOLD_TEST_PIPE_TARGET = link("/proc/self/fd/0");
  delete process.env.MIRAFOLD_TEST_DAEMON_OBSERVER;
  const createServer = http.createServer;
  http.createServer = function (...args) {
    observe("daemon-after-private-read");
    return Reflect.apply(createServer, this, args);
  };
  // Keep the real Claude SDK and its actual spawn options, replacing only
  // the model engine executable with a fixture. No model can be reached.
  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, args, options) {
    const index = Array.isArray(args) ? args.findIndex((arg) => typeof arg === "string" && /@anthropic-ai\/claude-agent-sdk\/cli\.js$/.test(arg)) : -1;
    const nativeClaude = typeof command === "string" && path.basename(command) === "claude" && args?.includes("--input-format") && args.includes("--output-format");
    if (index >= 0 || nativeClaude) {
      const fixture = fileURLToPath(new URL("./desktop-engine.mjs", import.meta.url));
      return spawn(process.execPath, [fixture, "claude", ...args.slice(nativeClaude ? 0 : index + 1)], options);
    }
    if (typeof command === "string" && command.startsWith(path.join(path.dirname(capture), "bin") + path.sep)) {
      return spawn(command, args, options);
    }
    throw new Error(`Desktop test refused child executable ${path.basename(String(command))}; argument files ${Array.isArray(args) ? args.filter((arg) => typeof arg === "string" && /\.(m?js)$/.test(arg)).map((arg) => path.basename(arg)).join(",") : "none"}`);
  };
  syncBuiltinESMExports();
} else if (process.env.MIRAFOLD_TEST_MCP_OBSERVER === "1") {
  delete process.env.MIRAFOLD_TEST_MCP_OBSERVER;
  observe("mcp");
}
