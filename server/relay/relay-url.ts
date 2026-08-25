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
import { envOff } from "../env";

export const DEFAULT_RELAY_URL = "wss://relay.mirafold.sh";
export const DEFAULT_APP_URL = "https://app.mirafold.com";

export type RelayPlan =
  /** Dial this relay. `url` is a valid ws:/wss: URL and `origin` its bare
   *  origin — the one outside destination the shell page's CSP admits.
   *  `appUrl` is set when a static app origin is known (explicit
   *  MIRAFOLD_APP_URL, or the baked default riding the baked relay);
   *  undefined keeps the HTTP-twin fallback. */
  | { kind: "dial"; url: string; origin: string; source: "explicit" | "default"; appUrl?: string }
  /** Remote access off. `opt-out` = user said so (quiet); `unentitled-default`
   *  = nothing configured, so the bake stood down (one actionable boot line);
   *  `malformed-url` = the explicit URL is not ws:/wss: and was REFUSED —
   *  refusing beats honoring, and local sessions never depend on the relay. */
  | { kind: "off"; reason: "opt-out" | "unentitled-default" }
  | { kind: "off"; reason: "malformed-url"; raw: string };

/** A relay URL's bare origin, or undefined when it is not a ws:/wss: URL. */
export function relayOriginOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "ws:" || u.protocol === "wss:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when a bearer credential riding this URL would cross the network in the
 * clear: a non-TLS scheme (`http:`/`ws:`) to a host that is not loopback. The
 * relay's E2E seal protects the *session*, but the entitlement token (relay
 * dial header) and the license key (entitlement-exchange POST body) travel
 * OUTSIDE that seal — over plaintext to a real host, anyone on the path reads
 * them and can impersonate the paying customer to the relay. Defaults are
 * `wss:`/`https:`, so this only fires when a user explicitly points a credential
 * at a plaintext non-loopback endpoint. Loopback is exempt: the dev stub and a
 * self-hosted relay on the same box carry nothing off-machine. A malformed URL
 * returns false — other code already refuses it. (2026-08-11 audit.)
 */
export function carriesCredentialInClear(urlString: string): boolean {
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  if (u.protocol === "https:" || u.protocol === "wss:") return false;
  if (u.protocol !== "http:" && u.protocol !== "ws:") return false;
  const host = u.hostname;
  const loopback =
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  return !loopback;
}

export function resolveRelayPlan(env: {
  MIRAFOLD_RELAY_URL?: string;
  MIRAFOLD_APP_URL?: string;
  MIRAFOLD_ENTITLEMENT_TOKEN?: string;
  MIRAFOLD_LICENSE_KEY?: string;
}): RelayPlan {
  const raw = env.MIRAFOLD_RELAY_URL?.trim();
  const appUrl = env.MIRAFOLD_APP_URL?.trim().replace(/\/+$/, "") || undefined;
  if (raw && envOff(raw)) return { kind: "off", reason: "opt-out" };
  if (raw) {
    const origin = relayOriginOf(raw);
    return origin
      ? { kind: "dial", url: raw, origin, source: "explicit", appUrl }
      : { kind: "off", reason: "malformed-url", raw };
  }
  const entitled = !!(env.MIRAFOLD_ENTITLEMENT_TOKEN?.trim() || env.MIRAFOLD_LICENSE_KEY?.trim());
  if (!entitled) return { kind: "off", reason: "unentitled-default" };
  return {
    kind: "dial",
    url: DEFAULT_RELAY_URL,
    origin: relayOriginOf(DEFAULT_RELAY_URL) as string,
    source: "default",
    appUrl: appUrl ?? DEFAULT_APP_URL,
  };
}
