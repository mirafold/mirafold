import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import { readFileSync } from "node:fs";
import { startDaemon, type Daemon } from "../testing/itest-harness";

// SECURITY.md: "It binds 127.0.0.1 deliberately" — the one line that keeps a
// LAN neighbour off the daemon. Every other test connects to loopback, so a
// listen on 0.0.0.0 passed all three tiers (test-audit 2026-08-26). This
// dials the machine's own non-loopback address and expects a refusal.

let d: Daemon;
before(async () => {
  d = await startDaemon();
});
after(async () => {
  await d.stop();
});

const lanAddress = (): string | undefined =>
  Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && !i.internal && i.family === "IPv4")?.address;

/** Linux fallback when the box has no LAN IPv4 (a `--network none`
 *  container, an IPv6-only host): the kernel's own socket table says what
 *  the port is bound to — 0100007F is 127.0.0.1, 00000000 is any. */
const boundAddressesFromProc = (port: number): string[] | undefined => {
  try {
    const hex = port.toString(16).toUpperCase().padStart(4, "0");
    const rows = [readFileSync("/proc/net/tcp", "utf8"), readFileSync("/proc/net/tcp6", "utf8")].join("\n").split("\n");
    return rows
      .map((r) => r.trim().split(/\s+/)[1] ?? "")
      .filter((local) => local.endsWith(`:${hex}`))
      .map((local) => local.split(":")[0]!);
  } catch {
    return undefined;
  }
};

test("the daemon is unreachable on this machine's LAN address — loopback only", async (t) => {
  const host = lanAddress();
  if (!host) {
    const bound = boundAddressesFromProc(d.port);
    if (!bound) {
      t.skip("no non-loopback IPv4 interface and no /proc/net/tcp on this box");
      return;
    }
    assert.ok(bound.length > 0, `port ${d.port} not found in the kernel socket table`);
    for (const addr of bound) assert.equal(addr, "0100007F", `port ${d.port} is bound to ${addr}, not loopback`);
    return;
  }
  const outcome = await new Promise<string>((resolve) => {
    const sock = net.connect({ host, port: d.port });
    sock.setTimeout(3_000);
    sock.once("connect", () => {
      sock.destroy();
      resolve("connected");
    });
    sock.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "error"));
    sock.once("timeout", () => {
      sock.destroy();
      resolve("timeout");
    });
  });
  // Anything but a connection is the promise kept (a runner's firewall may
  // DROP rather than refuse — cold review 2026-08-26).
  assert.notEqual(outcome, "connected", `port ${d.port} answered on ${host}`);
  // The same port on loopback answers — the refusal above is the bind, not a dead daemon.
  const loop = await new Promise<string>((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port: d.port });
    sock.once("connect", () => {
      sock.destroy();
      resolve("connected");
    });
    sock.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "error"));
  });
  assert.equal(loop, "connected");
});
