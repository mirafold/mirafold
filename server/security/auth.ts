// Socket auth primitives (Step 4.5), extracted from index.ts so the security
// predicates are unit-testable in isolation. The token gates both the HTTP app
// and the WebSocket; index.ts wires these into the Express middleware and the
// ws verifyClient. Pure functions only — no env reads, no server state.

import { timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "mirafold_token";

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
 * Cross-site WebSocket hijacking guard: a browser always sends Origin on a WS
 * handshake, so we require it to be a loopback host. Non-browser clients (wscat,
 * tests) send no Origin and are allowed through — they can't be weaponized by a
 * malicious page the way a browser socket can.
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
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
