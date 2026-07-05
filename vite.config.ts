import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: "web",
  plugins: [react()],
  resolve: {
    alias: {
      "@protocol": path.resolve(import.meta.dirname, "server/protocol.ts"),
      "@registry-spec": path.resolve(import.meta.dirname, "server/registry-spec.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        // 127.0.0.1, not localhost: the server binds to the IPv4 loopback, and
        // "localhost" can resolve to ::1 first and miss it.
        target: "ws://127.0.0.1:3000",
        ws: true,
      },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
