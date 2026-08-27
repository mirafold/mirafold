import type { AgentInfo, EntitlementView, WireMsg } from "@protocol";

/** The daemon's `agents` hello, typed off the protocol so a new hello field
 *  reaches every consumer through the compiler instead of three hand-kept
 *  mirrors. */
export type AgentsHello = Extract<WireMsg, { type: "agents" }>;

/** The pairing info a LOCAL viewport receives for the "connect a device" QR. */
export type RelayInfo = NonNullable<AgentsHello["relay"]>;

export type { EntitlementView };

/** Everything the hello carries that the shell keeps: which agents the daemon
 *  offers (null until the first hello), where it was launched, its home dir,
 *  the pairing info, its version, the billing affordance — plus the
 *  license-key read, which arrives as its own message after each hello. */
export type DaemonInfo = Omit<AgentsHello, "type" | "agents" | "default"> & {
  agents: AgentInfo[] | null;
  entitlement?: EntitlementView;
};

export const NO_DAEMON_INFO: DaemonInfo = { agents: null };

/** Fold a hello in. The license-key read is kept across a hello ONLY while
 *  the hello still says this daemon runs on a key (the read follows it
 *  again momentarily); a relaunched daemon without one must not inherit a
 *  stale "refused" read that would hide a working QR. */
export function daemonInfoFrom(hello: AgentsHello, prev?: DaemonInfo): DaemonInfo {
  const { type: _type, default: _default, ...info } = hello;
  const keep = hello.billing === "license-key" ? prev?.entitlement : undefined;
  return keep ? { ...info, entitlement: keep } : info;
}

/** Fold an `entitlement` message into what the shell holds. */
export function withEntitlement(prev: DaemonInfo, m: Extract<WireMsg, { type: "entitlement" }>): DaemonInfo {
  const { type: _type, ...entitlement } = m;
  return { ...prev, entitlement };
}
