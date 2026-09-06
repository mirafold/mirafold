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

import { performance } from "node:perf_hooks";
import { createLogger } from "../log";
import type { EntitlementView } from "../protocol";
import { carriesCredentialInClear } from "./relay-url";
import { isEntitlementHeaderValue } from "./relay-protocol";
export type { EntitlementView };

const log = createLogger("relay");

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // well inside the 48h token TTL
// Minimum gap between on-demand exchanges — throttles BOTH a forced (post-4007)
// refresh and a natural stale-cache one, so a lapsed key can't turn dial
// backoff into an HTTP hammer.
const FORCED_REFRESH_MIN_GAP_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const BILLING_RESPONSE_MAX_BYTES = 64 * 1024;
const ENTITLEMENT_TOKEN_MAX_BYTES = 8_192;
// Exact equality is unambiguous for every custom key. Embedded containment is
// meaningful only once the value is specific enough: otherwise a supported
// one-character custom key such as `a` would reject ordinary tokens like
// `safe.token`. Sixteen characters covers every official mf_ key and useful
// custom credentials without turning incidental short overlaps into outages.
const EMBEDDED_LICENSE_KEY_MIN_CHARS = 16;

const tokenReflectsLicenseKey = (token: string, licenseKey: string): boolean =>
  token === licenseKey ||
  (licenseKey.length >= EMBEDDED_LICENSE_KEY_MIN_CHARS && token.includes(licenseKey));
// A backend line rides to the pair/manage card with the known key removed
// and its length bounded. Shared
// with subscription.ts so both cards cap alike.
export const MAX_REASON_CHARS = 200;

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

/** A billing service already knows this key and can echo it in any string.
 * Remove the exact value before clipping, logging, or publishing that text. */
export const redactLicenseKey = (text: string, licenseKey: string): string =>
  licenseKey ? text.split(licenseKey).join(mask(licenseKey)) : text;

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

/** Parse one billing-backend JSON response without letting a chunked or
 *  misconfigured endpoint allocate an unlimited body first. */
export async function readBillingJson(res: Response): Promise<unknown> {
  if (!res.body) throw new Error("empty response");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BILLING_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("billing response exceeded the size limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}

export function createEntitlementTokenSource(env: {
  MIRAFOLD_ENTITLEMENT_TOKEN?: string;
  MIRAFOLD_LICENSE_KEY?: string;
  MIRAFOLD_ENTITLEMENT_URL?: string;
}): EntitlementTokenSource & { mode: EntitlementMode } {
  const suppliedOverride = env.MIRAFOLD_ENTITLEMENT_TOKEN?.trim();
  const override = suppliedOverride && isEntitlementHeaderValue(suppliedOverride)
    ? suppliedOverride
    : undefined;
  const licenseKey = env.MIRAFOLD_LICENSE_KEY?.trim();
  const url = resolveEntitlementUrl(env);

  if (suppliedOverride) {
    if (licenseKey) {
      log.warn(
        `both MIRAFOLD_ENTITLEMENT_TOKEN and MIRAFOLD_LICENSE_KEY are set — ` +
          `the token override wins; the license key is ignored`,
      );
    }
    if (!override) {
      log.warn(
        "MIRAFOLD_ENTITLEMENT_TOKEN is not usable as a request header and will be omitted — " +
          "the selected relay may refuse a tokenless dial; local sessions are unaffected",
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
  let dispatching = false;
  let pendingDispatch = false;
  // Dispatch runs OUTSIDE the exchange's try/catch (below) and each listener
  // is guarded: a throwing subscriber must not relabel the read or turn the
  // fire-and-forget refresh into an unhandled rejection. A listener can read
  // state() reentrantly; finish that newer transition before notifying any
  // remaining listeners so nobody receives a stale or duplicate read.
  const setView = (next: EntitlementView) => {
    if (next.state === view.state && next.reason === view.reason && next.cached === view.cached) return;
    view = next;
    if (dispatching) {
      pendingDispatch = true;
      return;
    }
    dispatching = true;
    try {
      for (;;) {
        pendingDispatch = false;
        const delivering = view;
        for (const cb of [...listeners]) {
          if (view !== delivering) {
            pendingDispatch = true;
            break;
          }
          try {
            cb(delivering);
          } catch (err) {
            let detail = "[unprintable thrown value]";
            try { detail = String(err); } catch {}
            log.warn(`entitlement listener threw: ${detail}`);
          }
          if (view !== delivering) {
            pendingDispatch = true;
            break;
          }
        }
        if (!pendingDispatch) break;
      }
    } finally {
      dispatching = false;
    }
  };
  // Every cached token has a wall-clock deadline, including one from a
  // successful exchange. Node timers use a separate monotonic clock, so a
  // long sleep or forward clock correction can cross that deadline without
  // completing one long relative timeout. Recheck wall time in one-second
  // hops, and also reconcile synchronously whenever state() is read.
  // A previously valid read checks again, observing the same request floor
  // as on-demand refresh; an outage read loses its cached-token allowance.
  const MAX_DELAY_MS = 2 ** 31 - 1;
  const EXPIRY_WALL_CHECK_MS = 1_000;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let lastFetchAt = -Infinity;
  const armTimer = (delayMs: number, callback: () => void) => {
    clearTimeout(expiry);
    if (stopped) return;
    expiry = setTimeout(callback, Math.min(MAX_DELAY_MS, Math.max(0, delayMs)));
    expiry.unref();
  };
  const reconcileExpiry = () => {
    if (stopped || !cached || cached.expMs > Date.now()) return;
    const expiredView = view;
    cached = undefined;
    clearTimeout(expiry);
    expiry = undefined;
    if (expiredView.state === "valid") {
      setView({ state: "checking" });
      armTimer(lastFetchAt + FORCED_REFRESH_MIN_GAP_MS - performance.now(), () => void refresh());
    } else if (expiredView.state === "unreachable" && expiredView.cached) {
      setView({ state: "unreachable", cached: false });
    }
  };
  const watchExpiry = (expMs: number) => {
    armTimer(Math.min(EXPIRY_WALL_CHECK_MS, expMs - Date.now()), () => {
      if (!cached || cached.expMs !== expMs) return;
      if (expMs > Date.now()) watchExpiry(expMs);
      else reconcileExpiry();
    });
  };
  let denied = false; // a 403 already warned — suppresses repeat WARNINGS only (the request throttle is FORCED_REFRESH_MIN_GAP_MS)
  let inflight: Promise<void> | undefined;

  const exchange = async (): Promise<void> => {
    lastFetchAt = performance.now();
    let next: EntitlementView;
    try {
      const res = await postLicenseKey(url, licenseKey, FETCH_TIMEOUT_MS);
      if (res.status === 403) {
        // The backend's body is untrusted JSON — any shape, `null` included;
        // only a string `reason` is quoted, and nothing here may throw.
        const body: unknown = await readBillingJson(res).catch(() => undefined);
        const raw = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
        const reason = typeof raw === "string" ? redactLicenseKey(raw, licenseKey).slice(0, MAX_REASON_CHARS) : undefined;
        if (!denied) {
          log.warn(
            `entitlement refused for license ${mask(licenseKey)}: ` +
              `${reason ?? "subscription lapsed or key invalid"} — remote access will be off ` +
              `until the subscription is active (local sessions are unaffected)`,
          );
        }
        denied = true;
        cached = undefined;
        next = { state: "invalid", ...(reason ? { reason } : {}) };
      } else {
        if (!res.ok) throw new Error(`http ${res.status}`);
        const body = (await readBillingJson(res)) as { token?: unknown; exp?: unknown };
        if (
          typeof body.token !== "string" ||
          body.token.length === 0 ||
          Buffer.byteLength(body.token, "utf8") > ENTITLEMENT_TOKEN_MAX_BYTES ||
          !isEntitlementHeaderValue(body.token) ||
          // Reject exact credential reuse at every length and embedded reuse
          // once the key is specific enough (see the threshold above).
          tokenReflectsLicenseKey(body.token, licenseKey) ||
          typeof body.exp !== "number" ||
          !Number.isFinite(body.exp * 1000) ||
          body.exp * 1000 <= Date.now()
        ) {
          throw new Error("malformed response");
        }
        cached = { token: body.token, expMs: body.exp * 1000 };
        denied = false;
        next = { state: "valid" };
      }
    } catch {
      // Endpoint down/unreachable: keep serving the cached token while it's
      // unexpired; otherwise we just have none. Quiet in the log — the
      // refusal line at dial time is the terminal's signal; the pair card
      // gets the honest read (and whether the cached token still carries it).
      const carried = !!cached && cached.expMs > Date.now();
      if (!carried) cached = undefined;
      next = { state: "unreachable", cached: carried };
    }
    // Install the cache's watch before publishing the read. A listener may
    // reconcile expiry reentrantly and replace it with a floor-delayed refresh;
    // the completing exchange must not overwrite that newer scheduling choice.
    if (cached) watchExpiry(cached.expMs);
    else {
      clearTimeout(expiry);
      expiry = undefined;
    }
    setView(next);
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
      reconcileExpiry();
      const stale = !cached;
      const throttled = performance.now() - lastFetchAt < FORCED_REFRESH_MIN_GAP_MS;
      if ((forced || stale) && !throttled) await refresh();
      else if (inflight) await inflight;
      reconcileExpiry();
      return cached?.token;
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(expiry);
    },
    state: () => {
      reconcileExpiry();
      return view;
    },
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
