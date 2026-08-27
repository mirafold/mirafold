import "./project-env-loader";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { WireMsg } from "./protocol";
import { SessionRegistry } from "./sessions/registry";
import { SessionCheckpointStore } from "./sessions/session-store";
import { openConnection } from "./sessions/connection";
import { probeLocalServers } from "./local-models";
import { sweepLiveness } from "./sessions/ws-liveness";
import { startRelayClient } from "./relay/relay-client";
import { createEntitlementTokenSource } from "./relay/entitlement";
import { createSubscriptionActions } from "./relay/subscription";
import { MIN_PAIRING_CODE_LENGTH, resolvePairingCode } from "./relay/relay-protocol";
import { carriesCredentialInClear, resolveRelayPlan, type RelayPlan } from "./relay/relay-url";
import {
  COOKIE_NAME,
  cookieToken,
  isAllowedOrigin,
  safeRedirectPath,
  startupUrl,
  tokensMatch,
  verifyToken,
} from "./security/auth";
import { createLogger, logFile, print } from "./log";
import { envInt } from "./env";
import { VERSION } from "./version";

const log = createLogger("mirafold");

// Last-gasp handlers — a crash stays loud and exits nonzero, it just
// signs its name first so a stranger's report contains something actionable
// — and the flight-recorder file keeps it even if the terminal is gone.
const lastGasp = (kind: string) => (err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log.error(`v${VERSION} crashed (${kind}): ${detail}`);
  log.error(
    "please report this at https://github.com/mirafold/mirafold/issues " +
      `(include the lines above${logFile ? ` — also in ${logFile}` : ""}; ` +
      "never paste the ?token= URL or a pairing code)",
  );
  process.exit(1);
};
process.on("uncaughtException", lastGasp("uncaughtException"));
process.on("unhandledRejection", lastGasp("unhandledRejection"));

const app = express();

// Resolved here (not with the relay block below) because the CSP's connect-src
// needs its origin. Unset no longer means off: the hosted relay is the baked
// default when an entitlement is configured (relay-url.ts has the full why;
// MIRAFOLD_RELAY_URL=off is the opt-out). A malformed URL resolves to `off`
// with its own reason — a bad value must narrow the policy, never widen it.
const relayPlan = resolveRelayPlan(process.env);
const relay = relayPlan.kind === "dial" ? resolveRelayDial(relayPlan) : undefined;
// Why remote access is off, for the pair button (protocol.ts `agents.relayOff`):
// the button is always drawn for a local viewport; without a relay it opens
// the honest state — a Mirafold Pro offer when nothing is configured.
const relayOff =
  relayPlan.kind !== "off"
    ? undefined
    : relayPlan.reason === "unentitled-default"
      ? ("unentitled" as const)
      : relayPlan.reason;

/** Everything the dial-out needs once a plan says "dial": the pairing code
 *  (minted per launch, or the pinned one when it is strong enough) and the
 *  user-facing pairing info the LOCAL hello carries so the shell can draw the
 *  "connect a device" QR — remote viewports never receive it. */
function resolveRelayDial(plan: Extract<RelayPlan, { kind: "dial" }>) {
  const { code, weakPin, pinProblem } = resolvePairingCode(process.env.MIRAFOLD_RELAY_CODE);
  if (weakPin) {
    // Refusing beats honoring: a guessable code is remote shell access for
    // whoever guesses it, and a code the pairing link can't carry pairs the
    // daemon but never a phone. The minted fallback keeps the relay usable.
    createLogger("relay").warn(
      pinProblem === "charset"
        ? `MIRAFOLD_RELAY_CODE contains characters outside A-Z a-z 0-9 _ - and was ` +
            `REFUSED — the phone's pairing link can't carry them, so pairing would ` +
            `silently fail. Using a freshly minted code instead (printed below).`
        : `MIRAFOLD_RELAY_CODE is shorter than ${MIN_PAIRING_CODE_LENGTH} chars and was REFUSED — ` +
            `a guessable pairing code hands remote shell access to whoever guesses it. ` +
            `Using a freshly minted code instead (printed below).`,
    );
  }
  // Where the phone loads the viewport app FROM (static-origin serving). The
  // relay serves no JS — the trust decision: whoever carries the traffic must
  // not serve the code that could read the pairing fragment. With an app
  // origin known the QR points there and `ws` rides the fragment so the page
  // knows where to dial; otherwise the relay URL's HTTP twin (dev + stub,
  // where one host plays both parts).
  const info = plan.appUrl
    ? { url: plan.appUrl, code, ws: plan.url }
    : { url: plan.url.replace(/^ws/, "http"), code };
  return { url: plan.url, origin: plan.origin, code, info };
}

// Defense-in-depth headers on the shell page. The client XSS surface is already
// closed (react-markdown escapes raw HTML, no innerHTML), so this guards against
// a future regression — and against a supply-chain compromise in the bundle,
// which no amount of reading our own code can prevent. `connect-src` is the
// directive that matters most there: it is the only one that limits where data
// can go OUT, so it is the wall in front of exfiltration.
//
// Never a bare scheme source (`ws:`, `wss:`): one matches ANY host on that
// scheme, permitting a socket to any server on the internet — exactly what
// this line exists to prevent. Same-origin + the configured relay is all the
// architecture needs (the daemon dials the relay itself; the browser talks
// to its own origin).
//
// `script-src`/`style-src` keep 'unsafe-inline' because the pre-paint theme
// script in index.html and React's inline style attributes need it — the
// tightening that matters here is connect/img/object/base/frame, not script.
// `frame-src 'self'` still admits the artifact's srcDoc iframe (verified); the
// iframe carries its OWN stricter CSP.
const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // The ONE outside destination the page may open a socket to. A local page
  // never dials the relay, but the same bundle serves the remote viewport and
  // picks its target from the URL, so naming the relay keeps the policy honest
  // for every flow that path can reach. One exact origin, not a wildcard.
  `connect-src ${["'self'", relay?.origin].filter(Boolean).join(" ")}`,
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
// the daemon launches from any directory. Resolves correctly from
// both homes: server/ in the dev checkout, dist-server/ in the packaged
// install. (Dev uses Vite on :5173 anyway.)
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

// Socket auth. The loopback bind keeps the internet and the LAN out,
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
  log.warn(
    "AUTH DISABLED (MIRAFOLD_TOKEN=\"\") — any page served from " +
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
      return res.redirect(safeRedirectPath(req.path));
    }
    // A bare denial is a dead end — name the recovery. The right URL
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
// `root` is load-bearing, not style: send's default dotfiles:"ignore" policy
// inspects EVERY segment of an absolute path, so passing the joined path 404s
// whenever the package is installed under a dot-directory — which is where
// `npm i -g` puts it for nvm (~/.nvm/…), asdf, volta and fnm users. `GET /`
// keeps working regardless (express.static passes a root, so only the request
// path is checked), so the breakage looks like "agent picker dies on the first
// session URL, but only for some people".
app.get("/s/:id", (_req, res) => res.sendFile("index.html", { root: DIST }));

const server = createServer(app);

// The port we ACTUALLY bound — the EADDRINUSE walk below can move us off
// basePort, and the Origin guard matches against our own origin. Read per
// handshake, never cached: the walk always finishes before a socket arrives,
// and -1 (not yet listening) matches nothing rather than widening the gate.
function boundPort(): number {
  const addr = server.address();
  return typeof addr === "object" && addr !== null ? addr.port : -1;
}

// Cap a single inbound frame so a hostile client can't force an unbounded
// allocation. Client messages (prompts, bang commands, stdin) are small; 1 MB
// is comfortably above any real one. Env-overridable.
const MAX_WS_PAYLOAD = envInt("MAX_WS_PAYLOAD", 1_000_000);

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: MAX_WS_PAYLOAD,
  verifyClient: (info: { origin?: string; req: IncomingMessage }) =>
    isAllowedOrigin(info.origin, { port: boundPort(), authEnabled: AUTH_ENABLED }) &&
    verifyToken(info.req, AUTH_TOKEN, AUTH_ENABLED),
});
// ws re-emits the http server's errors on itself; without a listener that
// throws and defeats the EADDRINUSE port walk below. The walk (or the loud
// rethrow) is handled on the http server — here we only log the rest.
wss.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") log.error(`[ws] ${err.stack ?? String(err)}`);
});

const registry = new SessionRegistry({ store: new SessionCheckpointStore() });

// Local model server discovery: fire-and-forget so a server already
// running lands in the first hello's `backends`; never awaited — startup
// must not wait on a probe. The picker's refresh_agents re-probes after.
void probeLocalServers();


// The manage-subscription backend — present only when this daemon
// runs on a license key (subscription.ts decides; token-override and
// self-host get nothing). Handed to LOCAL viewports only: billing actions
// stay on the machine that holds the key, so the relay path never sees it.
const subscriptionActions = createSubscriptionActions(process.env);

// The entitlement token source — a hand-issued token, a license key
// exchanged at the billing backend, or nothing (a gated relay will refuse
// the dial with an actionable line; local sessions never depend on this).
// Created here, before the first viewport, because the pair card presents on
// its read (protocol.ts `entitlement`); the relay block below dials with it.
const entitlement = relay ? createEntitlementTokenSource(process.env) : undefined;

// Per-socket liveness, read by the heartbeat below to reap half-open
// leftovers whose `close` never arrived (see ws-liveness.ts).
const liveViewports = new WeakMap<WebSocket, boolean>();

wss.on("connection", (ws) => {
  // The per-viewport logic lives in connection.ts (shared with the relay
  // path); this block only binds it to the local WebSocket transport.
  liveViewports.set(ws, true);
  // Without a per-socket listener, a transport error — an oversized frame
  // tripping maxPayload is the everyday case (a >1 MB paste into the prompt
  // box) — is an UNHANDLED 'error' event: it rides uncaughtException into
  // lastGasp and kills the whole daemon, every session included. Log it; ws
  // closes the offending socket itself and `close` → conn.close does the
  // detach.
  ws.on("error", (err) => log.error(`[viewport] socket error: ${String(err)}`));
  ws.on("pong", () => liveViewports.set(ws, true));
  const viewport = (msg: WireMsg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const conn = openConnection(registry, viewport, {
    label: "ws",
    relay: relay?.info,
    relayOff,
    subscription: subscriptionActions,
    entitlement,
  });
  ws.on("message", (data) => conn.handleMessage(String(data)));
  ws.on("close", conn.close);
});

// Server-side liveness heartbeat. Browsers auto-answer protocol pings, so
// a socket that misses a ping/pong round is a half-open leftover; terminating
// it fires `close` → conn.close → registry.detach, keeping viewport counts
// honest and letting idle sessions actually reach their reaper. Local sockets
// only — remote viewports have their own idle reaper (RELAY_VIEWPORT_IDLE_MS).
const WS_HEARTBEAT_MS = envInt("WS_HEARTBEAT_MS", 30_000);
const heartbeat = setInterval(() => sweepLiveness(wss.clients, liveViewports), WS_HEARTBEAT_MS);
heartbeat.unref(); // the listening server keeps the process alive; the beat shouldn't
wss.on("close", () => clearInterval(heartbeat));

// Bind to loopback only. The launch token (above) is the authentication; the
// Origin guard blocks hostile browser pages when auth is on (with auth off it
// admits any loopback origin — see the warning above); binding to 127.0.0.1
// keeps non-browser LAN clients — which send no Origin and so pass the guard
// — off the socket entirely. Remote viewports never reach this listener: the
// relay path is an outbound dial (below).
// A second daemon (another project, another terminal) must not crash on
// EADDRINUSE — walk up a few ports; the launcher reads the final URL off stdout.
const basePort = envInt("PORT", 3000);
const listen = (port: number) => {
  const onListening = () => {
    server.removeListener("error", onBusy); // later errors stay loud, as before
    // The token rides the URL so the launcher opens an authenticated page; the
    // browser trades it for the cookie on first load (see the auth block above).
    const url = startupUrl(port, AUTH_TOKEN);
    // print(): the launcher greps this stdout line for the URL, and the token
    // must never reach the log file — its file twin below is sanitized.
    print(`[mirafold] v${VERSION} — server on ${url} (ws at /ws)`);
    log.file(
      `v${VERSION} — server on http://127.0.0.1:${port}/ (ws at /ws; ` +
        `${AUTH_ENABLED ? "auth token elided" : "auth disabled"})`,
    );
  };
  const onBusy = (err: NodeJS.ErrnoException) => {
    // The stale "listening" callback must go with the failed attempt, or the
    // walk's eventual success fires EVERY attempt's callback and the log
    // claims "server on" ports we never bound — a line users copy.
    server.removeListener("listening", onListening);
    if (err.code === "EADDRINUSE" && port - basePort < 20) {
      log.info(`:${port} busy — trying :${port + 1}`);
      listen(port + 1);
    } else throw err;
  };
  server.once("error", onBusy);
  server.once("listening", onListening);
  server.listen(port, "127.0.0.1");
};
listen(basePort);

// Remote viewports arrive through an OUTBOUND dial to the relay — the daemon
// never opens a listening port for remote access. The pairing code is the
// root of trust for that path: printed here and shown as the QR, nowhere else
// — the E2E keys derive from it, and only its hash reaches the relay.
if (relay && entitlement) {
  // The entitlement token rides the dial as a plaintext header (relay-client.ts);
  // over a non-TLS non-loopback relay it can be read and replayed by anyone on
  // the path. Warn loudly, still dial (self-host is a real path).
  if (entitlement.mode !== "none" && carriesCredentialInClear(relay.url)) {
    createLogger("relay").warn(
      `MIRAFOLD_RELAY_URL is a plaintext (ws://) address to a non-local host — ` +
        `your entitlement token would be sent in the clear and could be stolen and ` +
        `reused. Use wss:// for a remote relay.`,
    );
  }
  startRelayClient({ url: relay.url, code: relay.code, registry, token: entitlement.get });
  const modeLine = {
    "token-override": "entitlement: hand-issued token (MIRAFOLD_ENTITLEMENT_TOKEN)",
    "license-key": "entitlement: license key (auto-refreshing token)",
    none: "entitlement: none configured — a gated relay will refuse this daemon",
  }[entitlement.mode];
  // print(): the pairing code is the root of trust for remote access — it may
  // reach the user's eyes, never the log file. The file twin elides it.
  print(
    `[relay] dialing ${relay.url} — pairing code: ${relay.code}\n` +
      `[relay] ${modeLine}\n` +
      `[relay] KEEP THAT CODE SECRET — it grants remote access to your sessions; ` +
      `never paste this boot output into an issue or chat`,
  );
  createLogger("relay").file(`dialing ${relay.url} (pairing code elided) — ${modeLine}`);
} else {
  switch (relayPlan.kind === "off" ? relayPlan.reason : undefined) {
    case "unentitled-default":
      // The baked default stood down (no entitlement configured). One
      // actionable line, not a nag: remote access is a paid feature and the
      // local product never depends on it.
      print(
        `[relay] remote access off — set MIRAFOLD_LICENSE_KEY (Mirafold Pro) to pair ` +
          `your phone; local sessions don't need it`,
      );
      break;
    case "malformed-url":
      // Refused here, named, instead of reaching `new WebSocket()` in the relay
      // client and dying as an unhandledRejection AFTER the "server on" line.
      createLogger("relay").warn(
        `MIRAFOLD_RELAY_URL is not a valid ws:// or wss:// URL and was REFUSED — ` +
          `remote access is OFF for this launch. Local sessions are unaffected. ` +
          `Expected something like wss://relay.mirafold.sh`,
      );
      break;
    case "opt-out":
      createLogger("relay").file("remote access disabled (MIRAFOLD_RELAY_URL=off)");
      break;
  }
}
