/**
 * Phase R.3 — the remote (relay) path. A remote page is opened as
 * /#code=<pairing code>: the code rides the URL FRAGMENT, which never leaves
 * the browser, so the relay's HTTP logs can't see it. It's stashed on the
 * device (in-app navigation — fleet row links, history.replaceState — drops the
 * fragment) and scrubbed from the address bar. Shell-owned state: agent output
 * can never read or set it.
 *
 * The stash is localStorage, NOT sessionStorage (2026-07-25, Kyle's phone).
 * Per-tab storage does not reliably survive what a phone actually does to a
 * backgrounded tab: switch to another app for a few minutes, and the browser is
 * free to discard the tab and rebuild it on return. The URL is unchanged (the
 * fragment was scrubbed on first load, by design) — so a rebuilt tab with no
 * stored code has no way to reach the daemon at all, and lands on a shell that
 * looks like a fresh session: no transcript, Explorer disabled, no end button,
 * prompts going nowhere. Reproduced exactly by wiping the store and reloading.
 *
 * What persisting it costs: the code is a bearer credential — whoever holds it
 * reaches the sessions — so it now outlives the tab on that device. Two things
 * bound that: pairing codes are per-launch (a daemon restart makes every stored
 * code useless), and this stash expires on its own after PAIRING_MAX_AGE_MS.
 * sessionStorage is still READ, so a tab paired by an older build keeps working.
 *
 * Static-origin serving (R.4/R.5): the page may be served from a static origin
 * that is NOT the relay (app.mirafold.com serves the bundle; relay.mirafold.sh
 * carries the socket — the trust split: whoever serves the JS must not carry
 * the traffic, and vice versa). The fragment then also carries
 * relay=<ws(s) origin> saying where to dial. Same-origin remains the fallback
 * (dev, and a self-host that serves both from one host).
 */

/** Parses `#code=…[&relay=…]`. Exported for tests — pure, no storage/DOM.
 *  The relay origin is honored only as a well-formed ws:/wss: URL (normalized
 *  to its origin); anything else — a crafted link steering the socket at some
 *  other protocol — is dropped, falling back to same-origin. */
export function relayTargetFromFragment(hash: string): { code: string; ws: string | null } | null {
  const code = hash.match(/(?:^#|&)code=([A-Za-z0-9_-]+)/);
  if (!code) return null;
  const raw = hash.match(/(?:^#|&)relay=([^&]+)/);
  let ws: string | null = null;
  if (raw) {
    try {
      const u = new URL(decodeURIComponent(raw[1]));
      if (u.protocol === "ws:" || u.protocol === "wss:") ws = u.origin;
    } catch {
      /* malformed — same-origin fallback */
    }
  }
  return { code: code[1], ws };
}

/** Parses the pairing fragment's session hint (`…&s=<id>`) — the session the
 *  QR was made from, so a paired device lands IN it rather than on the fleet.
 *  Honored only as a full `[\w-]+` token (the router's own id shape); anything
 *  else is dropped → mission control, today's behavior. One-shot intent for
 *  THIS load: unlike the code beside it, it is never stashed in storage —
 *  persisting it would bounce the device back into the session on every tap
 *  of home. Pure, exported for tests. */
export function sessionHintFromFragment(hash: string): string | null {
  return hash.match(/(?:^#|&)s=([\w-]+)(?:&|$)/)?.[1] ?? null;
}

const CODE_KEY = "mirafold-relay-code";
const WS_KEY = "mirafold-relay-ws";
const PAIRED_AT_KEY = "mirafold-relay-paired-at";
/** A stored pairing goes stale on its own — see the storage note above. */
const PAIRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Reads the device's stored pairing, dropping one that has aged out. Falls
 *  back to sessionStorage for tabs paired before the store moved. Exported for
 *  tests — takes its stores, touches no DOM. */
export function storedPairing(
  store: Storage,
  legacy: Storage | null = null,
  now: number = Date.now(),
): { code: string; ws: string | null } | null {
  const code = store.getItem(CODE_KEY);
  if (code) {
    const pairedAt = Number(store.getItem(PAIRED_AT_KEY) ?? 0);
    if (now - pairedAt <= PAIRING_MAX_AGE_MS) return { code, ws: store.getItem(WS_KEY) };
    for (const k of [CODE_KEY, WS_KEY, PAIRED_AT_KEY]) store.removeItem(k);
  }
  const carried = legacy?.getItem(CODE_KEY);
  return carried ? { code: carried, ws: legacy!.getItem(WS_KEY) } : null;
}

export function relayTargetFromPage(): { code: string; ws: string | null } | null {
  const target = relayTargetFromFragment(location.hash);
  if (target) {
    localStorage.setItem(CODE_KEY, target.code);
    localStorage.setItem(PAIRED_AT_KEY, String(Date.now()));
    // A fresh #code with no relay param must also CLEAR a stale stored origin —
    // the new pairing decides where to dial, not a leftover from the last one.
    if (target.ws) localStorage.setItem(WS_KEY, target.ws);
    else localStorage.removeItem(WS_KEY);
    history.replaceState(null, "", location.pathname + location.search);
    return target;
  }
  return storedPairing(localStorage, sessionStorage);
}

/** The href for the "new session" affordance, which opens a FRESH TAB. A new
 *  tab inherits neither the URL fragment nor — reliably, and never on a
 *  `noopener` open or on mobile — the opener's sessionStorage. So on the relay
 *  path the pairing target must be re-encoded into the new tab's fragment, or
 *  that tab finds no code, falls back to a local `ws://` origin with no daemon
 *  behind it, and hangs on "connecting" forever with the picker never arriving
 *  (the mobile new-session bug, 2026-07-24). The fragment stays client-side
 *  exactly as the QR's did — it is never sent to the relay, and the new tab
 *  scrubs it on load. A local page has no stored code and gets the plain URL.
 *  Reads storage lazily so tests can drive it; `base` defaults to the real
 *  new-session URL. */
export function newSessionHref(base = "/?new=1", storage: Storage = localStorage): string {
  const code = storage.getItem(CODE_KEY);
  if (!code) return base;
  const ws = storage.getItem(WS_KEY);
  const frag = ws
    ? `#code=${encodeURIComponent(code)}&relay=${encodeURIComponent(ws)}`
    : `#code=${encodeURIComponent(code)}`;
  return base + frag;
}
