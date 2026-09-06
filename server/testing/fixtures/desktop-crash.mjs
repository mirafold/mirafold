// Test-only failure injection after the unmodified built daemon has booted.
// The key is a synthetic fixture value; it never enters child environment/argv.
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
const createServer = http.createServer;
http.createServer = function (...args) {
  const server = Reflect.apply(createServer, this, args);
  server.on("request", (req) => {
    if (!req.url?.startsWith("/desktop-test-crash/")) return;
    const failure = new Error(`Desktop diagnostic fixture ${["mf_", "e".repeat(26)].join("")}`);
    setImmediate(() => {
      if (req.url.endsWith("/uncaughtException")) throw failure;
      else void Promise.reject(failure);
    });
  });
  return server;
};
syncBuiltinESMExports();
