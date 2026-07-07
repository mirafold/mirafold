// Phase R.1 — the in-repo relay stub, for dev and Tier-2/3 tests (the real
// deployed service is R.2, a separate repo). It is exactly as dumb as the
// real one must be: match ONE daemon dial-in to any number of browser
// viewports by pairing code, shuttle opaque payloads, parse only the
// envelope's routing fields — never `p`, never a WireMsg — log no frame
// contents, store nothing. It also serves ./dist so a real browser can load
// the app "remotely" in dev and Tier-3 tests; whether the production relay
// serves the shell at all is an R.2 decision.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import {
  CLOSE_BAD_CODE,
  CLOSE_CODE_TAKEN,
  DAEMON_PATH,
  MIN_CODE_LENGTH,
  VIEWPORT_PATH,
  type DaemonToRelay,
  type RelayToDaemon,
} from "./relay-protocol";

type Pair = { daemon: WebSocket; viewports: Map<string, WebSocket> };

export type RelayStub = { port: number; url: string; stop: () => Promise<void> };

export function startRelayStub(opts: { port?: number } = {}): Promise<RelayStub> {
  const app = express();
  const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  app.use(express.static(DIST));
  app.get("/s/:id", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

  const server = createServer(app);
  const pairs = new Map<string, Pair>();
  // Daemon-side envelopes carry whole WireMsgs (artifacts, capped tool
  // outputs), so the ceiling sits well above the client-frame cap.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8_000_000 });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "ws://relay");
    const code = url.searchParams.get("code") ?? "";
    if (url.pathname === DAEMON_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        // One daemon per code, ever — a second dial-in (or a guessably short
        // code) is refused, never silently adopted.
        if (code.length < MIN_CODE_LENGTH || pairs.has(code)) {
          ws.close(CLOSE_CODE_TAKEN);
          return;
        }
        const pair: Pair = { daemon: ws, viewports: new Map() };
        pairs.set(code, pair);
        ws.on("message", (data) => {
          let env: DaemonToRelay;
          try {
            env = JSON.parse(String(data)) as DaemonToRelay;
          } catch {
            return;
          }
          if (env.t === "pong") return;
          const viewport = pair.viewports.get(env.v);
          if (env.t === "frame" && viewport?.readyState === WebSocket.OPEN) {
            viewport.send(env.p); // opaque — routed, never parsed
          } else if (env.t === "close") {
            viewport?.close();
          }
        });
        ws.on("close", () => {
          pairs.delete(code);
          for (const viewport of pair.viewports.values()) viewport.close(CLOSE_BAD_CODE);
        });
      });
    } else if (url.pathname === VIEWPORT_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const pair = pairs.get(code);
        if (!pair) {
          ws.close(CLOSE_BAD_CODE);
          return;
        }
        const v = randomUUID().slice(0, 8);
        pair.viewports.set(v, ws);
        pair.daemon.send(JSON.stringify({ t: "open", v } satisfies RelayToDaemon));
        ws.on("message", (data) => {
          pair.daemon.send(
            JSON.stringify({ t: "frame", v, p: String(data) } satisfies RelayToDaemon),
          );
        });
        ws.on("close", () => {
          if (pair.viewports.delete(v) && pair.daemon.readyState === WebSocket.OPEN) {
            pair.daemon.send(JSON.stringify({ t: "close", v } satisfies RelayToDaemon));
          }
        });
      });
    } else {
      socket.destroy();
    }
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        url: `ws://127.0.0.1:${port}`,
        stop: () =>
          new Promise((done) => {
            // server.close waits out live sockets — drop them first.
            for (const pair of pairs.values()) {
              pair.daemon.terminate();
              for (const viewport of pair.viewports.values()) viewport.terminate();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

// Runnable standalone for dev: `node --import tsx server/relay-stub.ts`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRelayStub({ port: Number(process.env.PORT ?? 9100) }).then(({ url }) =>
    console.log(`[relay-stub] on ${url} — point the daemon at GENUI_RELAY_URL=${url}`),
  );
}
