// The daemon's entitlement token source. The relay admits a dial-out
// only with a valid signed token on the ENTITLEMENT_HEADER (when its gate is
// on); this module is where that token comes from. Two supplies:
//
//  - MIRAFOLD_ENTITLEMENT_TOKEN: a hand-issued token used verbatim — an
//    OPS/EMERGENCY path only, never a tester channel (beta testers pay real
//    subscriptions and get license keys via /pay).
//    When set, the exchange machinery below never starts — precedence beats
//    mutual exclusion so ops can override a broken exchange without
//    unsetting anything.
//  - MIRAFOLD_LICENSE_KEY: the paid path. The permanent key a customer gets at
//    checkout is exchanged at the billing backend (MIRAFOLD_ENTITLEMENT_URL,
//    default https://mirafold.com/api/entitlement) for a short-lived (~48h)
//    signed token, refreshed quietly in the background.
//
// Failure posture: this must NEVER throw, block, or degrade the local product.
// No token (endpoint down, subscription lapsed, nothing configured) just means
// the dial-out carries no header — a gated relay refuses it with 4007 and
// relay-client already prints the actionable line.

import { createLogger } from "../log";
import type { WireMsg } from "../protocol";
import { carriesCredentialInClear } from "./relay-url";

/** What the daemon tells local viewports about its key (protocol.ts
 *  `entitlement`, minus the tag). Undefined outside license-key mode. */
export type EntitlementView = Omit<Extract<WireMsg, { type: "entitlement" }>, "type">;

const log = createLogger("relay");

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // well inside the 48h token TTL
// Minimum gap between on-demand exchanges — throttles BOTH a forced (post-4007)
// refresh and a natural stale-cache one, so a lapsed key can't turn dial
// backoff into an HTTP hammer.
const FORCED_REFRESH_MIN_GAP_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
// The backend's refusal line rides to the pair card verbatim — bounded, like
// subscription.ts bounds the manage card's.
const MAX_REASON_CHARS = 200;

export type EntitlementTokenSource = {
  /** Current token, or undefined if none is available. `refresh: true` (after
   *  a 4007 refusal) forces a re-exchange first, throttled to once a minute. */
  get: (opts?: { refresh?: boolean }) => Promise<string | undefined>;
  stop: () => void;
  /** The current read for the pair card; undefined outside license-key mode. */
  state: () => EntitlementView | undefined;
  /** Called with each NEW read (dedupe is the source's job). Returns unsubscribe. */
  onChange: (cb: (view: EntitlementView) => void) => () => void;
};

/** What index.ts logs at boot — which supply is in play. */
export type EntitlementMode = "token-override" | "license-key" | "none";

// Never key bytes in a log line, not even a prefix — the flight recorder
// is promised paste-safe (audit 2026-08-26).
const mask = (_s: string) => "[license key]";

export const DEFAULT_ENTITLEMENT_URL = "https://mirafold.com/api/entitlement";

/** The one exchange endpoint both the token source and the manage-subscription
 *  actions talk to. */
export function resolveEntitlementUrl(env: { MIRAFOLD_ENTITLEMENT_URL?: string }): string {
  return env.MIRAFOLD_ENTITLEMENT_URL?.trim() || DEFAULT_ENTITLEMENT_URL;
}

/** The billing backend's one request shape: POST the license key as JSON,
 *  bounded by a timeout. Shared so the exchange and the manage actions can't
 *  drift apart in headers, body, or timeout idiom. */
export function postLicenseKey(endpoint: string, licenseKey: string, timeoutMs: number): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ licenseKey }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function createEntitlementTokenSource(env: {
  MIRAFOLD_ENTITLEMENT_TOKEN?: string;
  MIRAFOLD_LICENSE_KEY?: string;
  MIRAFOLD_ENTITLEMENT_URL?: string;
}): EntitlementTokenSource & { mode: EntitlementMode } {
  const override = env.MIRAFOLD_ENTITLEMENT_TOKEN?.trim();
  const licenseKey = env.MIRAFOLD_LICENSE_KEY?.trim();
  const url = resolveEntitlementUrl(env);

  if (override) {
    if (licenseKey) {
      log.warn(
        `both MIRAFOLD_ENTITLEMENT_TOKEN and MIRAFOLD_LICENSE_KEY are set — ` +
          `the token override wins; the license key is ignored`,
      );
    }
    return {
      mode: "token-override",
      get: async () => override,
      stop: () => {},
      state: () => undefined,
      onChange: () => () => {},
    };
  }
  if (!licenseKey) {
    return { mode: "none", get: async () => undefined, stop: () => {}, state: () => undefined, onChange: () => () => {} };
  }

  // The license key POSTs to the exchange in the clear if the operator pointed
  // MIRAFOLD_ENTITLEMENT_URL at a plaintext non-loopback host — anyone on the
  // path then reads the key. Warn loudly; still proceed (self-host is a real
  // path), matching the weak-pin / auth-off posture in index.ts.
  if (carriesCredentialInClear(url)) {
    log.warn(
      `MIRAFOLD_ENTITLEMENT_URL is a plaintext (http://) address to a non-local host — ` +
        `your license key would be sent in the clear and could be stolen in transit. ` +
        `Use https:// for a remote entitlement endpoint.`,
    );
  }

  let cached: { token: string; expMs: number } | undefined;
  // The read the pair card gets. Starts as `checking`; every exchange outcome
  // sets it, and only a CHANGED read reaches listeners.
  let view: EntitlementView = { state: "checking" };
  const listeners = new Set<(v: EntitlementView) => void>();
  const setView = (next: EntitlementView) => {
    if (next.state === view.state && next.reason === view.reason && next.cached === view.cached) return;
    view = next;
    for (const cb of listeners) cb(view);
  };
  let denied = false; // a 403 already warned — suppresses repeat WARNINGS only (the request throttle is FORCED_REFRESH_MIN_GAP_MS)
  let lastFetchMs = 0;
  let inflight: Promise<void> | undefined;

  const exchange = async (): Promise<void> => {
    lastFetchMs = Date.now();
    try {
      const res = await postLicenseKey(url, licenseKey, FETCH_TIMEOUT_MS);
      if (res.status === 403) {
        const reason = ((await res.json().catch(() => ({}))) as { reason?: string }).reason;
        if (!denied) {
          log.warn(
            `entitlement refused for license ${mask(licenseKey)}: ` +
              `${reason ?? "subscription lapsed or key invalid"} — remote access will be off ` +
              `until the subscription is active (local sessions are unaffected)`,
          );
        }
        denied = true;
        cached = undefined;
        setView({ state: "invalid", ...(reason ? { reason: reason.slice(0, MAX_REASON_CHARS) } : {}) });
        return;
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      const body = (await res.json()) as { token?: unknown; exp?: unknown };
      if (typeof body.token !== "string" || typeof body.exp !== "number") {
        throw new Error("malformed response");
      }
      cached = { token: body.token, expMs: body.exp * 1000 };
      denied = false;
      setView({ state: "valid" });
    } catch {
      // Endpoint down/unreachable: keep serving the cached token while it's
      // unexpired; otherwise we just have none. Quiet in the log — the
      // refusal line at dial time is the terminal's signal; the pair card
      // gets the honest read (and whether the cached token still carries it).
      setView({ state: "unreachable", cached: !!cached && cached.expMs > Date.now() });
    }
  };

  // Single-flight: dial + timer colliding must not double-POST.
  const refresh = (): Promise<void> => {
    inflight ??= exchange().finally(() => (inflight = undefined));
    return inflight;
  };

  void refresh(); // warm the cache at boot, fire-and-forget
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  timer.unref();

  return {
    mode: "license-key",
    get: async ({ refresh: forced = false } = {}) => {
      const stale = !cached || cached.expMs <= Date.now();
      const throttled = Date.now() - lastFetchMs < FORCED_REFRESH_MIN_GAP_MS;
      if ((forced || stale) && !throttled) await refresh();
      else if (inflight) await inflight;
      return cached && cached.expMs > Date.now() ? cached.token : undefined;
    },
    stop: () => clearInterval(timer),
    state: () => view,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
