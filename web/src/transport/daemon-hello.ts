import type { AgentInfo, EntitlementView, RelayOffReason, WireMsg } from "@protocol";

/** The daemon's `agents` hello, typed off the protocol so a new hello field
 *  reaches every consumer through the compiler instead of three hand-kept
 *  mirrors. */
export type AgentsHello = Extract<WireMsg, { type: "agents" }>;

/** The pairing info a LOCAL viewport receives for the "connect a device" QR. */
export type RelayInfo = NonNullable<AgentsHello["relay"]>;

export type { EntitlementView, RelayOffReason };

/** Everything the hello carries that the shell keeps: which agents the daemon
 *  offers (null until the first hello), where it was launched, its home dir,
 *  the pairing info, its version, the billing affordance, and the
 *  license-key read, and the optional local Desktop host. */
export type DaemonInfo = Omit<
  AgentsHello,
  "type" | "agents" | "default" | "relayOff" | "relayConfigProblem"
> & {
  agents: AgentInfo[] | null;
  relayOff?: RelayOffReason;
};

export const NO_DAEMON_INFO: DaemonInfo = { agents: null };

/** Fold a hello in — whole. The license-key read comes WITH the hello, so a
 *  hello without one (a relaunched daemon that no longer presents on the
 *  exchange) drops whatever was held: nothing carries over from a previous
 *  daemon. */
export function daemonInfoFrom(hello: AgentsHello): DaemonInfo {
  const {
    type: _type,
    default: _default,
    host,
    relayOff: rawRelayOff,
    relayConfigProblem,
    ...info
  } = hello;
  const relayOff: RelayOffReason | undefined =
    rawRelayOff === "unentitled" || rawRelayOff === "opt-out" || rawRelayOff === "malformed-url"
      ? rawRelayOff
      : relayConfigProblem === "invalid-entitlement-token"
        ? relayConfigProblem
        : undefined;
  return {
    ...info,
    ...(host === "desktop" ? { host } : {}),
    ...(relayOff ? { relayOff } : {}),
  };
}

/** Fold an `entitlement` change (between hellos) into what the shell holds. */
export function withEntitlement(prev: DaemonInfo, m: Extract<WireMsg, { type: "entitlement" }>): DaemonInfo {
  const { type: _type, ...entitlement } = m;
  return { ...prev, entitlement };
}
