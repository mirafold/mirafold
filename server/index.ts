import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import type { AgentName, ClientMsg, WireMsg } from "./protocol";
import { SessionRegistry, type SessionEntry } from "./registry";
import { runActionTool } from "./actions";
import { availableAgents, defaultAgent } from "./adapters";

// Agents the browser is allowed to name at onboarding (P.4). A create message
// naming anything else falls back to the daemon default rather than erroring.
const OFFERABLE = new Set(availableAgents().map((a) => a.agent));
const asAgent = (v: unknown): AgentName | undefined =>
  typeof v === "string" && OFFERABLE.has(v as AgentName) ? (v as AgentName) : undefined;

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
    viewport({ type: "session_created", sessionId: e.id, cwd: e.cwd, agent: e.agent });
    registry.attach(e, viewport);
    console.log(`[ws] viewport attached → session ${e.id} (${e.viewports.size} viewport(s))`);
  };

  // P.4: advertise which agents this daemon offers + which are live, so the
  // onboarding picker can render before any session exists. No agent assumed.
  // 4.8: also where the daemon was launched — the default cwd for new
  // sessions — plus home, so the client can show paths in ~-form.
  viewport({
    type: "agents",
    agents: availableAgents(),
    default: defaultAgent(),
    cwd: process.cwd(),
    home: os.homedir(),
  });

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
        // A bad cwd (typo'd path) rejects the create rather than silently
        // working somewhere else — the viewport stays unattached and the
        // onboarding card shows the error (Step 4.8).
        try {
          attachTo(
            registry.create({
              cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
              agent: asAgent(msg.agent),
            }),
          );
        } catch (err) {
          viewport({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
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
      case "action": {
        // Step 2.3: every component action is mediated here and logged.
        if (!entry || typeof msg.action !== "object" || msg.action === null) break;
        const src = typeof msg.sourceId === "string" ? msg.sourceId : "?";
        if (msg.action.kind === "prompt" && typeof msg.action.text === "string") {
          console.log(`[action] prompt from render ${src}`);
          registry.broadcast(entry, { type: "user_prompt", text: msg.action.text });
          entry.session.pushPrompt(msg.action.text);
        } else if (msg.action.kind === "tool" && typeof msg.action.name === "string") {
          const id = `action-${randomUUID().slice(0, 8)}`;
          registry.broadcast(entry, {
            type: "tool_use",
            name: msg.action.name,
            detail: `component action (${src})`,
            id,
          });
          const { output, isError } = runActionTool(
            msg.action.name,
            msg.action.args,
            entry.cwd,
          );
          registry.broadcast(entry, { type: "tool_result", output, isError, id });
        }
        // state actions never reach the server; anything else is ignored.
        break;
      }
    }
  });

  ws.on("close", () => {
    if (entry) {
      registry.detach(entry, viewport);
      console.log(`[ws] viewport detached ← session ${entry.id}`);
    }
  });
});

// Bind to loopback only. This daemon runs on the user's machine and the socket
// has no authentication (multi-user auth is Step 4.5; the relay dials out in
// 4.7). The Origin guard already blocks hostile browser pages; binding to
// 127.0.0.1 also keeps non-browser LAN clients — which send no Origin and so
// pass the guard — off the socket entirely.
server.listen(port, "127.0.0.1", () => {
  console.log(`[genui-shell] server on http://127.0.0.1:${port} (ws at /ws)`);
});
