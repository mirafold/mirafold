// R.5 — the daemon's entitlement token source. The relay admits a dial-out
// only with a valid signed token on the ENTITLEMENT_HEADER (when its gate is
// on); this module is where that token comes from. Two supplies:
//
//  - MIRAFOLD_ENTITLEMENT_TOKEN: a hand-issued token used verbatim — an
//    OPS/EMERGENCY path only, never a tester channel (beta testers pay real
//    subscriptions and get license keys via /pay; Kyle's rule, 2026-07-23).
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

const log = createLogger("relay");

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // well inside the 48h token TTL
const FORCED_REFRESH_MIN_GAP_MS = 60_000; // a lapsed key must not turn dial backoff into an HTTP hammer
const FETCH_TIMEOUT_MS = 10_000;

export type EntitlementTokenSource = {
  /** Current token, or undefined if none is available. `refresh: true` (after
   *  a 4007 refusal) forces a re-exchange first, throttled to once a minute. */
  get: (opts?: { refresh?: boolean }) => Promise<string | undefined>;
  stop: () => void;
};

/** What index.ts logs at boot — which supply is in play. */
export type EntitlementMode = "token-override" | "license-key" | "none";

const mask = (s: string) => `${s.slice(0, 6)}…`;

export function createEntitlementTokenSource(env: {
  MIRAFOLD_ENTITLEMENT_TOKEN?: string;
  MIRAFOLD_LICENSE_KEY?: string;
  MIRAFOLD_ENTITLEMENT_URL?: string;
}): EntitlementTokenSource & { mode: EntitlementMode } {
  const override = env.MIRAFOLD_ENTITLEMENT_TOKEN?.trim();
  const licenseKey = env.MIRAFOLD_LICENSE_KEY?.trim();
  const url = env.MIRAFOLD_ENTITLEMENT_URL?.trim() || "https://mirafold.com/api/entitlement";

  if (override) {
    if (licenseKey) {
      log.warn(
        `both MIRAFOLD_ENTITLEMENT_TOKEN and MIRAFOLD_LICENSE_KEY are set — ` +
          `the token override wins; the license key is ignored`,
      );
    }
    return { mode: "token-override", get: async () => override, stop: () => {} };
  }
  if (!licenseKey) {
    return { mode: "none", get: async () => undefined, stop: () => {} };
  }

  let cached: { token: string; expMs: number } | undefined;
  let denied = false; // a 403 — don't hammer; only a forced refresh retries
  let lastFetchMs = 0;
  let inflight: Promise<void> | undefined;

  const exchange = async (): Promise<void> => {
    lastFetchMs = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ licenseKey }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // the local-models.ts idiom
      });
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
        return;
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      const body = (await res.json()) as { token?: unknown; exp?: unknown };
      if (typeof body.token !== "string" || typeof body.exp !== "number") {
        throw new Error("malformed response");
      }
      cached = { token: body.token, expMs: body.exp * 1000 };
      denied = false;
    } catch {
      // Endpoint down/unreachable: keep serving the cached token while it's
      // unexpired; otherwise we just have none. Deliberately quiet — the
      // refusal line at dial time is the user-facing signal.
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
  };
}
