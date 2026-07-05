import { createServer } from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import type { ClientMsg, WireMsg } from "./protocol";
import { MockSession, Session, type AgentSession } from "./session";

// .env is optional — without an API key we fall back to the mock session.
try {
  process.loadEnvFile();
} catch {
  /* no .env yet */
}

const port = Number(process.env.PORT ?? 3000);
const app = express();
app.use(express.static("dist")); // built front end (dev uses Vite on :5173)

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

wss.on("connection", (ws) => {
  const live = Boolean(process.env.ANTHROPIC_API_KEY);
  // One session per connection for now; multi-session is Phase 4.
  const session: AgentSession = live ? new Session() : new MockSession();
  console.log(`[ws] client connected → ${live ? "live agent" : "mock"} session`);

  const send = (msg: WireMsg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  session.onMessage(send);

  ws.on("message", (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data)) as ClientMsg;
    } catch {
      send({ type: "error", message: "malformed client message" });
      return;
    }
    if (msg.type === "prompt" && typeof msg.text === "string" && msg.text.trim()) {
      session.pushPrompt(msg.text);
    } else if (msg.type === "interrupt") {
      session.interrupt();
    }
  });

  ws.on("close", () => {
    console.log("[ws] client disconnected");
    session.close();
  });
});

server.listen(port, () => {
  console.log(`[genui-shell] server on http://localhost:${port} (ws at /ws)`);
});
