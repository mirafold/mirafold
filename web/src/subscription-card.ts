// The manage-subscription card's brain, kept pure so Tier 1 pins
// it: the request/reply state machine (id-correlated, stale replies dropped)
// and the shell-owned copy composed from the daemon's subscription view.
// The component (ConnectDevice.tsx) only renders what this module decides.

import type { WireMsg } from "@protocol";

export type SubscriptionReply = Extract<WireMsg, { type: "subscription" }>;

export type CardState =
  /** A request is out; `waitId` names the one reply we'll accept. */
  | { phase: "loading"; waitId: string }
  /** A view arrived. `confirming` = the cancel confirm step is showing. */
  | { phase: "ready"; reply: SubscriptionReply; confirming: boolean }
  /** A cancel/uncancel is in flight — buttons disabled, no double-fire. */
  | { phase: "acting"; waitId: string }
  /** The daemon's error line (it already carries the support fallback). */
  | { phase: "failed"; message: string };

export const loading = (waitId: string): CardState => ({ phase: "loading", waitId });
export const acting = (waitId: string): CardState => ({ phase: "acting", waitId });

/** Fold one `subscription` reply in. A reply whose id isn't the one this
 *  card is waiting on is another surface's (or a stale retry's) — ignored. */
export function onReply(state: CardState, m: SubscriptionReply): CardState {
  if (state.phase !== "loading" && state.phase !== "acting") return state;
  if (m.id !== state.waitId) return state;
  if (m.error) return { phase: "failed", message: m.error };
  return { phase: "ready", reply: m, confirming: false };
}

/** "Aug 17, 2026" — or null for absent/garbled input (the line then simply
 *  omits the date rather than showing "Invalid Date"). */
export function day(iso: string | undefined): string | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(iso);
  if (!match) return null;
  const [year, month, date, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (date < 1 || date > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** The status line plus which single action (if any) the card offers. */
export function describeSubscription(reply: SubscriptionReply): {
  line: string;
  action: "cancel" | "uncancel" | null;
} {
  const cancelDay = day(reply.cancelAt);
  const periodDay = day(reply.periodEnd);
  if (cancelDay) {
    return {
      line: `cancellation scheduled — access ends ${cancelDay}`,
      action: "uncancel",
    };
  }
  switch (reply.status) {
    case "trialing":
      return { line: periodDay ? `free trial — first charge ${periodDay}` : "free trial", action: "cancel" };
    case "active":
      return { line: periodDay ? `active — renews ${periodDay}` : "active", action: "cancel" };
    case "past_due":
      // Cancel stays offered: stopping future attempts is exactly what a
      // past-due customer may want. Fixing the card is Paddle's surface.
      return {
        line: "payment past due — update your card from your Paddle receipt email",
        action: "cancel",
      };
    case "canceled":
      return { line: "subscription ended", action: null };
    case "paused":
      return { line: "subscription is paused", action: null };
    default:
      return { line: "subscription status unavailable", action: null };
  }
}

/** The confirm step's consequence sentence — must stay true to /terms and
 *  /refunds: end-of-period only, trial cancels are never charged. */
export function confirmLede(reply: SubscriptionReply): string {
  const d = day(reply.periodEnd);
  if (reply.status === "trialing") {
    return d
      ? `Cancel now and you'll never be charged. Your trial access still runs to ${d}.`
      : "Cancel now and you'll never be charged. Your trial access still runs to its end.";
  }
  return d
    ? `You won't be charged again. Access runs to ${d}, then the subscription ends.`
    : "You won't be charged again. Access runs to the end of the paid period, then the subscription ends.";
}
