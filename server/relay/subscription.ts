// Phase CS — the daemon's side of self-serve subscription management. Active
// only in `license-key` mode: the license key is the bearer credential to the
// billing backend's manage endpoints, so token-override (ops) and self-host
// (no key) daemons have nothing to manage and get no affordance. The key
// itself never crosses the viewport wire in either direction — the browser
// asks THIS daemon, and this daemon presents the key, exactly like the
// entitlement exchange.
//
// Endpoint discovery: derived from MIRAFOLD_ENTITLEMENT_URL (no new env
// vars) — the default https://mirafold.com/api/entitlement yields
// …/api/subscription[/cancel|/uncancel]. A custom exchange URL that doesn't
// end in /entitlement is a shape we can't derive siblings for, so the
// feature simply stays off — never a guess at someone else's routes.
//
// Failure posture mirrors entitlement.ts: never throw, never block; any
// outage degrades to the standing support-email path the site promises.

import { createLogger } from "../log";

const log = createLogger("relay");

const FETCH_TIMEOUT_MS = 10_000;
// A cancel is a hand-clicked action; anything faster than this per action
// burst is a stuck client or a hostile one — serve the refusal, not Paddle.
const MIN_GAP_MS = 2_000;
const MAX_REASON_CHARS = 200;

/** What the manage-subscription card renders — nothing more rides back. */
export type SubscriptionView = { status: string; periodEnd?: string; cancelAt?: string };
export type SubscriptionResult = { view: SubscriptionView } | { error: string };

export type SubscriptionActions = {
  status: () => Promise<SubscriptionResult>;
  cancel: () => Promise<SubscriptionResult>;
  uncancel: () => Promise<SubscriptionResult>;
};

/** The one fallback line — the path /refunds already promises, so an outage
 *  never strands a customer with no way to cancel. */
export const SUPPORT_FALLBACK =
  "billing backend unreachable — email support@mirafold.com and we'll handle it directly";

/** Exported for the boot log + tests: where the manage endpoints live for a
 *  given exchange URL, or undefined when underivable. */
export function subscriptionBase(entitlementUrl: string): string | undefined {
  const base = entitlementUrl.replace(/\/entitlement\/?$/, "/subscription");
  return base === entitlementUrl ? undefined : base;
}

const optionalIso = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function createSubscriptionActions(env: {
  MIRAFOLD_ENTITLEMENT_TOKEN?: string;
  MIRAFOLD_LICENSE_KEY?: string;
  MIRAFOLD_ENTITLEMENT_URL?: string;
}): SubscriptionActions | undefined {
  if (env.MIRAFOLD_ENTITLEMENT_TOKEN?.trim()) return undefined; // ops override — no key in play
  const licenseKey = env.MIRAFOLD_LICENSE_KEY?.trim();
  if (!licenseKey) return undefined;
  const url = env.MIRAFOLD_ENTITLEMENT_URL?.trim() || "https://mirafold.com/api/entitlement";
  const base = subscriptionBase(url);
  if (!base) {
    log.warn(
      `manage-subscription off: MIRAFOLD_ENTITLEMENT_URL doesn't end in /entitlement, ` +
        `so the manage endpoints can't be derived from it`,
    );
    return undefined;
  }

  const call = async (endpoint: string): Promise<SubscriptionResult> => {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ licenseKey }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 403 || res.status === 400) {
        // Our backend's own composed refusal (unknown/superseded key). Shown
        // as-is but bounded: a self-hoster can point the exchange anywhere,
        // and this string lands in a shell-owned surface.
        const reason = ((await res.json().catch(() => ({}))) as { reason?: string; error?: string });
        const text = typeof reason.reason === "string" ? reason.reason : reason.error;
        return { error: (text || SUPPORT_FALLBACK).slice(0, MAX_REASON_CHARS) };
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.status !== "string") throw new Error("malformed response");
      const view: SubscriptionView = { status: body.status.slice(0, 40) };
      const periodEnd = optionalIso(body.periodEnd);
      const cancelAt = optionalIso(body.cancelAt);
      if (periodEnd) view.periodEnd = periodEnd;
      if (cancelAt) view.cancelAt = cancelAt;
      return { view };
    } catch {
      return { error: SUPPORT_FALLBACK };
    }
  };

  return {
    status: () => call(base),
    cancel: () => call(`${base}/cancel`),
    uncancel: () => call(`${base}/uncancel`),
  };
}

/**
 * Per-connection guard shared by the three message handlers: one in-flight
 * action at a time with a floor between starts, so a stuck button or a
 * hostile viewport can't turn clicks into a Paddle hammer. Throttled
 * requests still get a reply — silence strands the card in "working".
 */
export function createSubscriptionThrottle(minGapMs = MIN_GAP_MS) {
  let lastStart = 0;
  let inflight = false;
  return {
    tryStart(): boolean {
      const now = Date.now();
      if (inflight || now - lastStart < minGapMs) return false;
      lastStart = now;
      inflight = true;
      return true;
    },
    done(): void {
      inflight = false;
    },
  };
}
