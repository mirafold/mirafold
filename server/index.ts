import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import type { AgentName, ClientMsg, WireMsg } from "./protocol";
import { SessionRegistry, type SessionEntry } from "./registry";
import { runActionTool } from "./actions";
import { availableAgents, defaultAgent } from "./adapters";
import { spawnBang } from "./pty";
import { COOKIE_NAME, cookieToken, isLoopbackOrigin, verifyToken } from "./auth";

// How much of a `!` command's output rides into the agent's context with the
// next prompt (tail-kept — the end of a long output is usually the payload).
// The wire/replay stream is never capped by this; it only bounds the context
// injection so one verbose command can't eat the model's window.
const BANG_CONTEXT_CAP = Number(process.env.BANG_CONTEXT_CAP ?? 16_000);

/**
 * Step 4.9: prompts carry any finished-since-last-turn `!` transcripts as
 * leading context — terminal-faithful (the model sees what you ran), and
 * agent-neutral: it consumes only the AgentSession seam's pushPrompt, so
 * every engine gets it without per-adapter code. The user_prompt broadcast
 * stays the raw typed text; only the engine sees the injected block.
 */
const pushWithBangContext = (entry: SessionEntry, text: string) => {
  const blocks = entry.pendingBang.splice(0);
  entry.session.pushPrompt(
    blocks.length ? `${blocks.join("\n")}\n${text}` : text,
  );
};

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

const app = express();

// Defense-in-depth headers on the shell page. The client XSS surface is already
// closed (react-markdown escapes raw HTML, no innerHTML), so this guards against
// a future regression: it caps where the app can source/connect (no external
// script or exfil target beyond the local WS), forbids being framed
// (clickjacking), and stops MIME sniffing. `script-src`/`style-src` keep
// 'unsafe-inline' because the pre-paint theme script in index.html and React's
// inline style attributes need it — the tightening that matters here is
// connect/img/object/base/frame, not script. `frame-src 'self'` still admits the
// artifact's srcDoc iframe (verified); the iframe carries its OWN stricter CSP.
const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", SHELL_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// The built front end lives at ../dist relative to THIS FILE, not the cwd —
// the daemon launches from any directory (4.8/4.10). Resolves correctly from
// both homes: server/ in the dev checkout, dist-server/ in the packaged
// install. (Dev uses Vite on :5173 anyway.)
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

// Socket auth (Step 4.5). The loopback bind keeps the internet and the LAN out,
// but "same machine" includes every OTHER user account on a shared box — and the
// socket drives a shell as us. A per-launch token closes that: it gates the
// served app AND the WebSocket, so another local user (who never sees the token)
// can't connect. The launcher opens a URL carrying the token; the browser keeps
// it as a SameSite cookie, so refreshes, new tabs, and fleet links all present
// it automatically — no per-URL threading. Set GENUI_TOKEN="" to disable (a
// single-user machine, or the Vite dev proxy on :5173, whose cross-origin page
// can't present the daemon's cookie — `dev:server` sets it empty for that).
const AUTH_TOKEN = process.env.GENUI_TOKEN ?? randomUUID();
const AUTH_ENABLED = AUTH_TOKEN !== "";

if (AUTH_ENABLED) {
  // Guards every HTTP route below (app shell, assets, /s/:id). A valid cookie
  // passes; a valid `?token=` query mints the cookie then redirects to the
  // clean path so the token never lingers in the address bar or history.
  app.use((req, res, next) => {
    if (cookieToken(req.headers.cookie) === AUTH_TOKEN) return next();
    if (typeof req.query.token === "string" && req.query.token === AUTH_TOKEN) {
      res.cookie(COOKIE_NAME, AUTH_TOKEN, { httpOnly: true, sameSite: "strict", path: "/" });
      return res.redirect(req.path);
    }
    res.status(403).type("text/plain").send("genui-shell: missing or invalid token");
  });
}

app.use(express.static(DIST));
// /s/<id> is client-side routing — serve the app shell.
app.get("/s/:id", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

const server = createServer(app);

// Cap a single inbound frame so a hostile client can't force an unbounded
// allocation. Client messages (prompts, bang commands, stdin) are small; 1 MB
// is comfortably above any real one. Env-overridable.
const MAX_WS_PAYLOAD = Number(process.env.MAX_WS_PAYLOAD ?? 1_000_000);

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: MAX_WS_PAYLOAD,
  verifyClient: (info: { origin?: string; req: IncomingMessage }) =>
    isLoopbackOrigin(info.origin) && verifyToken(info.req, AUTH_TOKEN, AUTH_ENABLED),
});
// ws re-emits the http server's errors on itself; without a listener that
// throws and defeats the EADDRINUSE port walk below. The walk (or the loud
// rethrow) is handled on the http server — here we only log the rest.
wss.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") console.error("[ws]", err);
});

const registry = new SessionRegistry();

wss.on("connection", (ws) => {
  // A connection is a viewport onto one registry session (Step 4.2) — or,
  // since 4.6, a fleet watcher observing the registry itself.
  let entry: SessionEntry | null = null;
  let watching = false;
  const viewport = (msg: WireMsg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // Identity first, then the replayed history, then the live stream. 4.4:
  // a valid afterSeq turns the replay into a tail-only resume — the client
  // is told via `resumed` so it keeps its state instead of repainting.
  const attachTo = (e: SessionEntry, afterSeq?: number) => {
    if (entry) registry.detach(entry, viewport);
    entry = e;
    const resumed = afterSeq !== undefined && registry.canResume(e, afterSeq);
    viewport({
      type: "session_created",
      sessionId: e.id,
      cwd: e.cwd,
      agent: e.agent,
      ...(resumed ? { resumed: true } : {}),
    });
    registry.attach(e, viewport, resumed ? afterSeq : undefined);
    console.log(
      `[ws] viewport ${resumed ? `resumed @${afterSeq}` : "attached"} → session ${e.id} (${e.viewports.size} viewport(s))`,
    );
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
        // session rather than an error page — unless the session cap rejects
        // the fallback create, which surfaces as an error (not a crash).
        const existing =
          typeof msg.sessionId === "string" ? registry.get(msg.sessionId) : undefined;
        const afterSeq =
          existing && typeof msg.afterSeq === "number" ? msg.afterSeq : undefined;
        try {
          attachTo(existing ?? registry.create(), afterSeq);
        } catch (err) {
          viewport({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case "prompt":
        if (entry && typeof msg.text === "string" && msg.text.trim()) {
          // Echo the user turn through the session stream so every viewport
          // (and the replay buffer) renders the command strip.
          registry.broadcast(entry, { type: "user_prompt", text: msg.text });
          pushWithBangContext(entry, msg.text);
        }
        break;
      case "bang": {
        // The `!` passthrough (4.9): run it in a PTY in the session's cwd —
        // instant, zero tokens, never routed through the model.
        if (!entry || typeof msg.command !== "string" || !msg.command.trim()) break;
        if (!/^[\w-]{1,64}$/.test(String(msg.id))) break;
        if (entry.bang) {
          viewport({ type: "error", message: "a ! command is already running (stop it first)" });
          break;
        }
        const e = entry;
        const { command, id } = msg;
        let output = "";
        registry.broadcast(e, { type: "bang_start", command, id });
        const proc = spawnBang(
          command,
          e.cwd,
          (data) => {
            output += data;
            registry.broadcast(e, { type: "bang_output", data, id });
          },
          (exitCode) => {
            e.bang = undefined;
            registry.broadcast(e, { type: "bang_end", id, exitCode });
            // Queue the transcript for the agent's next turn. Tail-kept cap;
            // echo-off input (passwords) was never in the PTY output, so it
            // can't leak into context here either.
            const tail =
              output.length > BANG_CONTEXT_CAP
                ? `(… ${output.length - BANG_CONTEXT_CAP} chars elided …)\n` +
                  output.slice(-BANG_CONTEXT_CAP)
                : output;
            e.pendingBang.push(
              `<bash-input>${command}</bash-input>\n<bash-output exit-code="${exitCode ?? "killed"}">\n${tail}</bash-output>`,
            );
          },
        );
        e.bang = { id, proc };
        break;
      }
      case "bang_input":
        // EPHEMERAL SECRET PATH: straight to the PTY, nothing else — no
        // broadcast, no buffer, no log (a password may be in `data`).
        if (entry?.bang && entry.bang.id === msg.id && typeof msg.data === "string") {
          entry.bang.proc.write(msg.data);
        }
        break;
      case "bang_kill":
        if (entry?.bang && entry.bang.id === msg.id) entry.bang.proc.kill();
        break;
      case "ping":
        // Liveness only — answered on this connection, never buffered.
        viewport({ type: "pong" });
        break;
      case "watch_sessions":
        // 4.6: this connection is the fleet page — snapshots, not a session.
        if (entry) {
          registry.detach(entry, viewport);
          entry = null;
        }
        watching = true;
        registry.watch(viewport);
        break;
      case "rename":
        if (typeof msg.sessionId === "string" && typeof msg.name === "string") {
          registry.rename(msg.sessionId, msg.name);
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
          pushWithBangContext(entry, msg.action.text);
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
    if (watching) registry.unwatch(viewport);
  });
});

// Bind to loopback only. This daemon runs on the user's machine and the socket
// has no authentication (multi-user auth is Step 4.5; the relay dials out in
// 4.7). The Origin guard already blocks hostile browser pages; binding to
// 127.0.0.1 also keeps non-browser LAN clients — which send no Origin and so
// pass the guard — off the socket entirely.
// 4.10: a second daemon (another project, another terminal) must not crash on
// EADDRINUSE — walk up a few ports; the launcher reads the final URL off stdout.
const basePort = Number(process.env.PORT ?? 3000);
const listen = (port: number) => {
  const onBusy = (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && port - basePort < 20) listen(port + 1);
    else throw err;
  };
  server.once("error", onBusy);
  server.listen(port, "127.0.0.1", () => {
    server.removeListener("error", onBusy); // later errors stay loud, as before
    // The token rides the URL so the launcher opens an authenticated page; the
    // browser trades it for the cookie on first load (see the auth block above).
    const url = `http://127.0.0.1:${port}/${AUTH_ENABLED ? `?token=${AUTH_TOKEN}` : ""}`;
    console.log(`[genui-shell] server on ${url} (ws at /ws)`);
  });
};
listen(basePort);
