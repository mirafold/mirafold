import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { envInt } from "./server/env";

export default defineConfig(() => {
  const daemonPort = envInt("PORT", 3000);

  return {
    root: "web",
    plugins: [react()],
    resolve: {
      alias: {
        "@protocol": path.resolve(import.meta.dirname, "server/protocol.ts"),
        "@registry-spec": path.resolve(import.meta.dirname, "server/registry-spec.ts"),
        "@relay-crypto": path.resolve(import.meta.dirname, "server/relay/relay-crypto.ts"),
      },
    },
    server: {
      // #1/#4: open the dev UI on launch so there's no manual address entry. This
      // is the :5173 URL a developer actually uses (the daemon serves the shared
      // PORT selected by `yarn dev`; the installed `mirafold` CLI opens its own
      // port itself in bin/). Vite spawns the browser detached, so its logs never
      // bleed into the terminal. Opt out with MIRAFOLD_NO_OPEN=1 (CI, a second
      // terminal, an already-open tab).
      open: !process.env.MIRAFOLD_NO_OPEN,
      port: 5173,
      proxy: {
        "/ws": {
          // 127.0.0.1, not localhost: the server binds to the IPv4 loopback, and
          // "localhost" can resolve to ::1 first and miss it. `yarn dev` exports
          // this same PORT to the daemon, so its fallback cannot strand the proxy.
          target: `ws://127.0.0.1:${daemonPort}`,
          ws: true,
        },
      },
    },
    build: {
      outDir: "../dist",
      emptyOutDir: true,
    },
  };
});
