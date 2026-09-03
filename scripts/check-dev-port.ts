import { createServer } from "node:net";
import { envInt } from "../server/env";

const port = envInt("PORT", 3100);
const probe = createServer();

probe.once("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `[mirafold] port ${port} is already in use; stop that process or choose another PORT`,
    );
  } else {
    console.error(`[mirafold] could not reserve port ${port}: ${error.message}`);
  }
  process.exitCode = 1;
});

probe.once("listening", () => probe.close());
probe.listen(port, "127.0.0.1");
