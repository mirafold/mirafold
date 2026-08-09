// Socket auth primitives (Step 4.5), extracted from index.ts so the security
// predicates are unit-testable in isolation. The token gates both the HTTP app
// and the WebSocket; index.ts wires these into the Express middleware and the
// ws verifyClient. Pure functions only — no env reads, no server state.

import { timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "mirafold_token";

/** The one startup URL printed for the launcher. URLSearchParams keeps an
 *  operator-supplied token as data, even when it contains shell metacharacters. */
export function startupUrl(port: number, token: string): string {
  const url = new URL(`http://127.0.0.1:${port}/`);
  if (token !== "") url.searchParams.set("token", token);
  return url.href;
}

/**
 * Constant-time token comparison. A plain `===` on a secret can leak it one
 * character at a time via how long the mismatch takes to reject; comparing in
 * time that doesn't depend on where the first difference is closes that. The
 * token's LENGTH isn't secret (it's fixed for the launch), so bailing early on
 * a length mismatch is fine — only equal-length inputs reach the timing-safe
 * compare, which never throws on them.
 */
export function tokensMatch(candidate: string | null | undefined, expected: string): boolean {
  if (candidate == null) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Just enough of an http/ws request to check auth — so tests can pass a plain
 *  object and Node's IncomingMessage satisfies it structurally. */
export type TokenRequest = { headers: { cookie?: string }; url?: string };

/** The auth token carried in a Cookie header, if present. */
export function cookieToken(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Where the post-token redirect may send the browser. A request path always
 * starts with "/", but one starting with "//" (or "/\", which browsers treat
 * the same) becomes a protocol-relative Location header — an off-machine
 * redirect. Only someone who already holds the token can trigger it, so this
 * is principle, not a live hole (2026-07-15 audit #4).
 */
export function safeRedirectPath(path: string): string {
  return path.startsWith("//") || path.startsWith("/\\") ? "/" : path;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origins our own served page can have, normalized (URL drops default
 *  ports, so a comparison against `URL.origin` stays exact either way). */
function selfOrigins(port: number): Set<string> {
  const set = new Set<string>();
  for (const host of LOOPBACK_HOSTS) {
    try {
      set.add(new URL(`http://${host}:${port}`).origin);
    } catch {
      /* an unbound port (-1) yields nothing to match — refuse, don't widen */
    }
  }
  return set;
}

/**
 * Cross-site WebSocket hijacking guard. A browser always sends Origin on a WS
 * handshake; non-browser clients (wscat, tests) send none and are allowed
 * through — they can't be weaponized by a malicious page, and the token still
 * gates them.
 *
 * With auth ON the match is EXACT — scheme, host, AND our own port. A
 * host-family check ("any loopback origin") is NOT enough: the auth cookie is
 * scoped by host but never by port, and an IP literal is its own registrable
 * domain, so SameSite=Strict doesn't fire between ports either. That makes a
 * page served from http://127.0.0.1:<any other port> — another dev server, a
 * hostile npm postinstall's local server — same-site with us: the browser
 * attaches our cookie to its handshake and the socket drives a shell as the
 * user. Scheme is part of the match for the same reason (cookies aren't
 * scheme-isolated, so an https loopback page could present ours too), and we
 * only ever serve http (2026-07-27 audit).
 *
 * With auth OFF there is no cookie to steal and any local page can connect
 * regardless — index.ts says exactly that, loudly, at boot — so the looser
 * loopback-family rule stands. The Vite dev proxy on :5173 depends on it
 * (`dev:server` sets MIRAFOLD_TOKEN="").
 */
export function isAllowedOrigin(
  origin: string | undefined,
  opts: { port: number; authEnabled: boolean },
): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  if (!opts.authEnabled) return true;
  return selfOrigins(opts.port).has(url.origin);
}

/**
 * Does the request carry the expected token? It rides as the SameSite cookie
 * (browsers) or a `?token=` query on the ws URL (non-browser clients). When auth
 * is disabled (empty token) everything passes — the single-user / dev posture.
 */
export function verifyToken(req: TokenRequest, expected: string, enabled: boolean): boolean {
  if (!enabled) return true;
  if (tokensMatch(cookieToken(req.headers.cookie), expected)) return true;
  const q = new URL(req.url ?? "", "http://localhost").searchParams.get("token");
  return tokensMatch(q, expected);
}
