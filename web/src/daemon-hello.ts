import type { AgentInfo, WireMsg } from "@protocol";

/** The daemon's `agents` hello, typed off the protocol so a new hello field
 *  reaches every consumer through the compiler instead of three hand-kept
 *  mirrors. */
export type AgentsHello = Extract<WireMsg, { type: "agents" }>;

/** The pairing info a LOCAL viewport receives for the "connect a device" QR. */
export type RelayInfo = NonNullable<AgentsHello["relay"]>;

/** Everything the hello carries that the shell keeps: which agents the daemon
 *  offers (null until the first hello), where it was launched, its home dir,
 *  the pairing info, its version, and the billing affordance. */
/** The daemon's license-key read (protocol.ts `entitlement`), minus the tag. */
export type EntitlementView = Omit<Extract<WireMsg, { type: "entitlement" }>, "type">;

export type DaemonInfo = Omit<AgentsHello, "type" | "agents" | "default"> & {
  agents: AgentInfo[] | null;
  /** Arrives after the hello (and on change) — kept across hello re-sends. */
  entitlement?: EntitlementView;
};

export const NO_DAEMON_INFO: DaemonInfo = { agents: null };

export function daemonInfoFrom(hello: AgentsHello, prev?: DaemonInfo): DaemonInfo {
  const { type: _type, default: _default, ...info } = hello;
  return prev?.entitlement ? { ...info, entitlement: prev.entitlement } : info;
}

/** Fold an `entitlement` message into what the shell holds. */
export function withEntitlement(prev: DaemonInfo, m: Extract<WireMsg, { type: "entitlement" }>): DaemonInfo {
  const { type: _type, ...entitlement } = m;
  return { ...prev, entitlement };
}
