// The daemon's side of self-serve subscription management. Active
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
import { inflightSlot, minInterval } from "../throttle";
import {
  MAX_REASON_CHARS,
  postLicenseKey,
  readBillingJson,
  redactLicenseKey,
  resolveEntitlementUrl,
} from "./entitlement";

const log = createLogger("billing");

const FETCH_TIMEOUT_MS = 10_000;
// A cancel is a hand-clicked action; anything faster than this per action
// burst is a stuck client or a hostile one — serve the refusal, not Paddle.
const MIN_GAP_MS = 2_000;

/** What the manage-subscription card renders — nothing more rides back. */
export const KNOWN_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "paused", "canceled"] as const;
type KnownSubscriptionStatus = (typeof KNOWN_SUBSCRIPTION_STATUSES)[number];
const knownSubscriptionStatuses = new Set<string>(KNOWN_SUBSCRIPTION_STATUSES);
export type SubscriptionView = {
  status: KnownSubscriptionStatus | "unknown";
  periodEnd?: string;
  cancelAt?: string;
};
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

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const optionalIso = (v: unknown, licenseKey: string): string | undefined => {
  if (typeof v !== "string" || v.length > 64) return undefined;
  const safe = redactLicenseKey(v, licenseKey);
  const match = ISO_INSTANT.exec(safe);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return undefined;
  return Number.isFinite(Date.parse(safe)) ? safe : undefined;
};

export function createSubscriptionActions(env: {
  MIRAFOLD_ENTITLEMENT_TOKEN?: string;
  MIRAFOLD_LICENSE_KEY?: string;
  MIRAFOLD_ENTITLEMENT_URL?: string;
}): SubscriptionActions | undefined {
  if (env.MIRAFOLD_ENTITLEMENT_TOKEN?.trim()) return undefined; // ops override — no key in play
  const licenseKey = env.MIRAFOLD_LICENSE_KEY?.trim();
  if (!licenseKey) return undefined;
  const url = resolveEntitlementUrl(env);
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
      const res = await postLicenseKey(endpoint, licenseKey, FETCH_TIMEOUT_MS);
      if (res.status === 403 || res.status === 400) {
        // Our backend's own composed refusal (unknown/superseded key). Shown
        // with the known key removed and length bounded: a self-hoster can point the exchange anywhere,
        // and this string lands in a shell-owned surface.
        const reason = ((await readBillingJson(res).catch(() => ({}))) as {
          reason?: string;
          error?: string;
        });
        const text = typeof reason.reason === "string" ? reason.reason : reason.error;
        return { error: redactLicenseKey(text || SUPPORT_FALLBACK, licenseKey).slice(0, MAX_REASON_CHARS) };
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      const body = (await readBillingJson(res)) as Record<string, unknown>;
      if (typeof body.status !== "string") throw new Error("malformed response");
      // These values become shell-owned copy. Forward only Paddle's five
      // subscription states; a future or hostile string gets a fixed unknown
      // state rather than arbitrary text in the trusted UI. Redact first: the
      // terminal deliberately accepts arbitrary keys, including a low-entropy
      // value that could otherwise collide with one of the known states.
      const safeStatus = redactLicenseKey(body.status, licenseKey);
      const status: SubscriptionView["status"] = knownSubscriptionStatuses.has(safeStatus)
        ? (safeStatus as KnownSubscriptionStatus)
        : "unknown";
      const view: SubscriptionView = { status };
      const periodEnd = optionalIso(body.periodEnd, licenseKey);
      const cancelAt = optionalIso(body.cancelAt, licenseKey);
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
  const gap = minInterval(minGapMs);
  const slot = inflightSlot();
  return {
    tryStart(): boolean {
      if (slot.busy || !gap.take()) return false;
      slot.take();
      return true;
    },
    done(): void {
      slot.release();
    },
  };
}
