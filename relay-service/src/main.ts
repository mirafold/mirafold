// genui-relay entrypoint — the container's CMD. Reads PORT/HOST from the
// environment (limits come from env inside limits.ts), starts the forwarder,
// and shuts down cleanly on SIGTERM/SIGINT (the platform's stop signal).

import { startRelay } from "./relay.js";

const relay = await startRelay({
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "0.0.0.0",
});

let closing = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    console.log(`[${new Date().toISOString()}] ${sig} — draining and closing`);
    relay.close().then(() => process.exit(0));
    // Never hang the platform's stop past its grace window.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

// A crash stays loud and exits nonzero (the platform restarts the instance).
process.on("uncaughtException", (err) => {
  console.error(`[${new Date().toISOString()}] uncaughtException:`, err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(`[${new Date().toISOString()}] unhandledRejection:`, err);
  process.exit(1);
});
