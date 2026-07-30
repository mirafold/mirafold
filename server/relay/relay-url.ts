// The default-relay bake (R.2's launch blocker, landed with R.5's gate ON).
//
// Unset MIRAFOLD_RELAY_URL no longer means "relay off" — it means "use the
// hosted relay", but ONLY when an entitlement is configured. An unentitled
// daemon dialing the gated relay is a guaranteed 4007 refusal on a widening
// retry forever: a log line every ≤30 s for the user and pointless churn for
// the relay. So the baked default engages exactly when a dial could succeed;
// otherwise remote access stays off with a single actionable boot line.
//
// An EXPLICIT url keeps today's behavior verbatim, entitled or not — that is
// the self-host path (an ungated relay accepts tokenless dials) and the dev
// stub path. The app-origin default travels WITH the relay default: a phone
// pairing through the hosted relay loads the viewport from the hosted static
// origin; an explicit relay with no MIRAFOLD_APP_URL keeps the HTTP-twin
// fallback (dev + stub, where one host plays both parts — see index.ts).
export const DEFAULT_RELAY_URL = "wss://relay.mirafold.sh";
export const DEFAULT_APP_URL = "https://app.mirafold.com";

/** The documented opt-out values — remote access off, no default engaged. */
const OPT_OUT = /^(off|none|disabled|false|0)$/i;

export type RelayPlan =
  /** Dial this relay. `appUrl` is set when a static app origin is known
   *  (explicit MIRAFOLD_APP_URL, or the baked default riding the baked relay);
   *  undefined keeps the HTTP-twin fallback. */
  | { kind: "dial"; url: string; source: "explicit" | "default"; appUrl?: string }
  /** Remote access off. `opt-out` = user said so (quiet); `unentitled-default`
   *  = nothing configured, so the bake stood down (one actionable boot line). */
  | { kind: "off"; reason: "opt-out" | "unentitled-default" };

export function resolveRelayPlan(env: {
  MIRAFOLD_RELAY_URL?: string;
  MIRAFOLD_APP_URL?: string;
  MIRAFOLD_ENTITLEMENT_TOKEN?: string;
  MIRAFOLD_LICENSE_KEY?: string;
}): RelayPlan {
  const raw = env.MIRAFOLD_RELAY_URL?.trim();
  const appUrl = env.MIRAFOLD_APP_URL?.trim().replace(/\/+$/, "") || undefined;
  if (raw && OPT_OUT.test(raw)) return { kind: "off", reason: "opt-out" };
  if (raw) return { kind: "dial", url: raw, source: "explicit", appUrl };
  const entitled = !!(env.MIRAFOLD_ENTITLEMENT_TOKEN?.trim() || env.MIRAFOLD_LICENSE_KEY?.trim());
  if (!entitled) return { kind: "off", reason: "unentitled-default" };
  return { kind: "dial", url: DEFAULT_RELAY_URL, source: "default", appUrl: appUrl ?? DEFAULT_APP_URL };
}
