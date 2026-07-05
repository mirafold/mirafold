import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import type { ClientMsg, WireMsg } from "./protocol";
import { SessionRegistry, type SessionEntry } from "./registry";

// .env is optional — without an API key we fall back to the mock session.
try {
  process.loadEnvFile();
} catch {
  /* no .env yet */
}

const port = Number(process.env.PORT ?? 3000);
const app = express();
app.use(express.static("dist")); // built front end (dev uses Vite on :5173)
// /s/<id> is client-side routing — serve the app shell.
app.get("/s/:id", (_req, res) => res.sendFile(path.resolve("dist/index.html")));

const server = createServer(app);

// Cross-site WebSocket hijacking guard: a browser always sends Origin on a
// WS handshake, so we require it to be a loopback host. Non-browser clients
// (wscat, tests) send no Origin and are allowed through — they can't be
// weaponized by a malicious page the way a browser socket can.
const isLoopbackOrigin = (origin: string | undefined): boolean => {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
};

const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ origin }: { origin?: string }) => isLoopbackOrigin(origin),
});

const registry = new SessionRegistry();

wss.on("connection", (ws) => {
  // A connection is a viewport onto one registry session (Step 4.2).
  let entry: SessionEntry | null = null;
  const viewport = (msg: WireMsg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const attachTo = (e: SessionEntry) => {
    if (entry) registry.detach(entry, viewport);
    entry = e;
    // Identity first, then the replayed history, then the live stream.
    viewport({ type: "session_created", sessionId: e.id, cwd: e.cwd });
    registry.attach(e, viewport);
    console.log(`[ws] viewport attached → session ${e.id} (${e.viewports.size} viewport(s))`);
  };

  ws.on("message", (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data)) as ClientMsg;
    } catch {
      viewport({ type: "error", message: "malformed client message" });
      return;
    }
    switch (msg.type) {
      case "create":
        attachTo(registry.create(typeof msg.cwd === "string" ? msg.cwd : undefined));
        break;
      case "attach": {
        // A stale/unknown id (old bookmark, server restart) gets a fresh
        // session rather than an error page.
        const existing =
          typeof msg.sessionId === "string" ? registry.get(msg.sessionId) : undefined;
        attachTo(existing ?? registry.create());
        break;
      }
      case "prompt":
        if (entry && typeof msg.text === "string" && msg.text.trim()) {
          // Echo the user turn through the session stream so every viewport
          // (and the replay buffer) renders the command strip.
          registry.broadcast(entry, { type: "user_prompt", text: msg.text });
          entry.session.pushPrompt(msg.text);
        }
        break;
      case "interrupt":
        entry?.session.interrupt();
        break;
      case "permission_response":
        if (typeof msg.id === "string" && typeof msg.allow === "boolean") {
          entry?.session.resolvePermission(msg.id, msg.allow);
        }
        break;
    }
  });

  ws.on("close", () => {
    if (entry) {
      registry.detach(entry, viewport);
      console.log(`[ws] viewport detached ← session ${entry.id}`);
    }
  });
});

server.listen(port, () => {
  console.log(`[genui-shell] server on http://localhost:${port} (ws at /ws)`);
});
