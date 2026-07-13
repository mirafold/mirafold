import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { WireMsg } from "./protocol";
import { SessionRegistry } from "./registry";
import { openConnection } from "./connection";
import { sweepLiveness } from "./ws-liveness";
import { startRelayClient } from "./relay-client";
import { MIN_PAIRING_CODE_LENGTH, resolvePairingCode } from "./relay-protocol";
import { COOKIE_NAME, cookieToken, isLoopbackOrigin, tokensMatch, verifyToken } from "./auth";
import { VERSION } from "./version";

// R.4g: last-gasp handlers — a crash stays loud and exits nonzero, it just
// signs its name first so a stranger's report contains something actionable.
const lastGasp = (kind: string) => (err: unknown) => {
  console.error(`[mirafold] v${VERSION} crashed (${kind}):`, err);
  console.error(
    "[mirafold] please report this at https://github.com/kserrec/genui-shell/issues " +
      "(include the two lines above; never paste the ?token= URL or a pairing code)",
  );
  process.exit(1);
};
process.on("uncaughtException", lastGasp("uncaughtException"));
process.on("unhandledRejection", lastGasp("unhandledRejection"));

// .env is optional — without an API key we fall back to the mock session.
// R.4g: on Node < 20.12 loadEnvFile doesn't exist; swallowing that silently
// strands a valid key in .env in mock mode with no clue why — say so.
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* no .env yet */
  }
} else {
  console.warn(
    `[mirafold] this Node (${process.version}) can't read .env (needs >= 20.12) — ` +
      "credentials set in .env were NOT loaded; export them in the environment or upgrade Node",
  );
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
// it automatically — no per-URL threading. Set MIRAFOLD_TOKEN="" to disable (a
// single-user machine, or the Vite dev proxy on :5173, whose cross-origin page
// can't present the daemon's cookie — `dev:server` sets it empty for that).
const AUTH_TOKEN = process.env.MIRAFOLD_TOKEN ?? randomUUID();
const AUTH_ENABLED = AUTH_TOKEN !== "";

if (!AUTH_ENABLED) {
  // Auth off means the loopback-Origin guard is the ONLY gate — and it admits
  // ANY page served from localhost (any port). So any local web content the
  // user has open (another dev server, a hostile npm postinstall's local
  // server) can drive this agent: shell + file access as the user. Fine for a
  // single-user dev box (the Vite proxy needs it); a loud line so it's never
  // an accident on a shared machine or a forgotten production setting.
  console.warn(
    "[mirafold] AUTH DISABLED (MIRAFOLD_TOKEN=\"\") — any page served from " +
      "localhost can drive this agent (shell + file access). Safe only on a " +
      "single-user machine; never run this way on a shared box or in production.",
  );
}

if (AUTH_ENABLED) {
  // Guards every HTTP route below (app shell, assets, /s/:id). A valid cookie
  // passes; a valid `?token=` query mints the cookie then redirects to the
  // clean path so the token never lingers in the address bar or history.
  app.use((req, res, next) => {
    if (tokensMatch(cookieToken(req.headers.cookie), AUTH_TOKEN)) return next();
    if (typeof req.query.token === "string" && tokensMatch(req.query.token, AUTH_TOKEN)) {
      res.cookie(COOKIE_NAME, AUTH_TOKEN, { httpOnly: true, sameSite: "strict", path: "/" });
      return res.redirect(req.path);
    }
    // R.4b: a bare denial is a dead end — name the recovery. The right URL
    // (with ?token=…) is in the terminal that launched mirafold.
    res
      .status(403)
      .type("text/plain")
      .send(
        "mirafold: missing or invalid token.\n" +
          "Open the full URL (with ?token=...) printed by the terminal where mirafold is running.",
      );
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

// Relay config (Phase R). The pairing code is minted once per launch (or
// pinned via MIRAFOLD_RELAY_CODE); its HTTP twin of MIRAFOLD_RELAY_URL is what a
// phone's browser opens. Local viewports get both in the hello so the shell
// can draw the "connect a device" QR (R.4) — remote viewports never do.
const RELAY_URL = process.env.MIRAFOLD_RELAY_URL;
let RELAY_CODE: string | undefined;
if (RELAY_URL) {
  const { code, weakPin } = resolvePairingCode(process.env.MIRAFOLD_RELAY_CODE);
  if (weakPin) {
    // Refusing beats honoring: a guessable code is remote shell access for
    // whoever guesses it, and the minted fallback keeps the relay usable.
    console.warn(
      `[relay] MIRAFOLD_RELAY_CODE is shorter than ${MIN_PAIRING_CODE_LENGTH} chars and was REFUSED — ` +
        `a guessable pairing code hands remote shell access to whoever guesses it. ` +
        `Using a freshly minted code instead (printed below).`,
    );
  }
  RELAY_CODE = code;
}
// Where the phone loads the viewport app FROM (static-origin serving). The
// relay serves no JS — the trust decision: whoever carries the traffic must
// not serve the code that could read the pairing fragment. With
// MIRAFOLD_APP_URL set (e.g. https://app.mirafold.com) the QR points there and
// `ws` rides the fragment so the page knows where to dial; unset falls back to
// the relay URL's HTTP twin (dev + stub, where one host plays both parts).
const APP_URL = process.env.MIRAFOLD_APP_URL?.trim().replace(/\/+$/, "");
const relayInfo =
  RELAY_URL && RELAY_CODE
    ? APP_URL
      ? { url: APP_URL, code: RELAY_CODE, ws: RELAY_URL }
      : { url: RELAY_URL.replace(/^ws/, "http"), code: RELAY_CODE }
    : undefined;

// #10: per-socket liveness, read by the heartbeat below to reap half-open
// leftovers whose `close` never arrived (see ws-liveness.ts).
const liveViewports = new WeakMap<WebSocket, boolean>();

wss.on("connection", (ws) => {
  // The per-viewport logic lives in connection.ts (shared with the R.1 relay
  // path); this block only binds it to the local WebSocket transport.
  liveViewports.set(ws, true);
  ws.on("pong", () => liveViewports.set(ws, true));
  const viewport = (msg: WireMsg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const conn = openConnection(registry, viewport, "ws", relayInfo);
  ws.on("message", (data) => conn.handleMessage(String(data)));
  ws.on("close", conn.close);
});

// #10: server-side liveness heartbeat. Browsers auto-answer protocol pings, so
// a socket that misses a ping/pong round is a half-open leftover; terminating
// it fires `close` → conn.close → registry.detach, keeping viewport counts
// honest and letting idle sessions actually reach their reaper. Local sockets
// only — remote viewports have their own idle reaper (RELAY_VIEWPORT_IDLE_MS).
const WS_HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS ?? 30_000);
const heartbeat = setInterval(() => sweepLiveness(wss.clients, liveViewports), WS_HEARTBEAT_MS);
heartbeat.unref(); // the listening server keeps the process alive; the beat shouldn't
wss.on("close", () => clearInterval(heartbeat));

// Bind to loopback only. This daemon runs on the user's machine and the socket
// has no authentication (multi-user auth is Step 4.5; the relay dials out in
// 4.7). The Origin guard already blocks hostile browser pages; binding to
// 127.0.0.1 also keeps non-browser LAN clients — which send no Origin and so
// pass the guard — off the socket entirely.
// 4.10: a second daemon (another project, another terminal) must not crash on
// EADDRINUSE — walk up a few ports; the launcher reads the final URL off stdout.
const basePort = Number(process.env.PORT ?? 3000);
const listen = (port: number) => {
  const onListening = () => {
    server.removeListener("error", onBusy); // later errors stay loud, as before
    // The token rides the URL so the launcher opens an authenticated page; the
    // browser trades it for the cookie on first load (see the auth block above).
    const url = `http://127.0.0.1:${port}/${AUTH_ENABLED ? `?token=${AUTH_TOKEN}` : ""}`;
    console.log(`[mirafold] v${VERSION} — server on ${url} (ws at /ws)`);
  };
  const onBusy = (err: NodeJS.ErrnoException) => {
    // The stale "listening" callback must go with the failed attempt, or the
    // walk's eventual success fires EVERY attempt's callback and the log
    // claims "server on" ports we never bound — a line users copy (R.4b).
    server.removeListener("listening", onListening);
    if (err.code === "EADDRINUSE" && port - basePort < 20) {
      console.log(`[mirafold] :${port} busy — trying :${port + 1}`);
      listen(port + 1);
    } else throw err;
  };
  server.once("error", onBusy);
  server.once("listening", onListening);
  server.listen(port, "127.0.0.1");
};
listen(basePort);

// Phase R.1: remote viewports arrive through an OUTBOUND dial to the relay —
// the daemon never opens a listening port for remote access. The pairing code
// is the root of trust for that path: printed here and shown as the R.4 QR,
// nowhere else — R.3 derives the E2E keys from it, and only its hash reaches
// the relay. Off unless MIRAFOLD_RELAY_URL is set.
if (RELAY_URL && RELAY_CODE) {
  startRelayClient({ url: RELAY_URL, code: RELAY_CODE, registry });
  console.log(
    `[relay] dialing ${RELAY_URL} — pairing code: ${RELAY_CODE}\n` +
      `[relay] KEEP THAT CODE SECRET — it grants remote access to your sessions; ` +
      `never paste this boot output into an issue or chat`,
  );
}
