// Shared test helper (R.1/R.3/R.2): the browser side of the encrypted relay
// channel, exactly as ws.ts implements it — connect with the derived pairId,
// handshake, then seal/open every frame. Used by relay.itest.ts (against the
// in-repo stub) and relay-service.itest.ts (against the deployable service),
// so both drive the real crypto path a phone would.

import WebSocket from "ws";
import type { ClientMsg, WireMsg } from "../protocol";
import type { Daemon } from "../testing/itest-harness";
import { PAIR_PARAM, VIEWPORT_PATH } from "./relay-protocol";
import {
  derivePair,
  frameCiphers,
  openHandshake,
  randomBytes,
  sealHandshake,
  type FrameCipher,
} from "./relay-crypto";

type Any = WireMsg & Record<string, any>;

export class RemoteClient {
  ws!: WebSocket;
  received: WireMsg[] = [];
  closed!: Promise<{ code: number }>;
  private cipher!: FrameCipher;
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private cursor = 0;
  private wake: (() => void)[] = [];

  static connect(port: number, code: string, pairIdOverride?: string): Promise<RemoteClient> {
    return RemoteClient.connectUrl(`ws://127.0.0.1:${port}`, code, pairIdOverride);
  }

  /** Same client against any relay URL — e.g. the DEPLOYED one (wss://…). */
  static async connectUrl(base: string, code: string, pairIdOverride?: string): Promise<RemoteClient> {
    const c = new RemoteClient();
    const pair = await derivePair(code);
    const pairId = pairIdOverride ?? pair.id;
    c.ws = new WebSocket(`${base}${VIEWPORT_PATH}?${PAIR_PARAM}=${pairId}`);
    c.closed = new Promise((res) => {
      c.ws.on("close", (code) => res({ code }));
      c.ws.on("error", () => res({ code: -1 }));
    });
    await new Promise<void>((res, rej) => {
      c.ws.on("open", res);
      c.ws.on("error", rej);
    });
    const nonceC = randomBytes(32);
    // The permanent listener goes on BEFORE our handshake frame is sent, and
    // every frame rides the serialized recvChain — the first one completes the
    // handshake, the rest decrypt in arrival order. This mirrors ws.ts's
    // structure exactly, and the parity is load-bearing: the daemon sends its
    // handshake reply and the encrypted hello back-to-back, and a once()+
    // late-listener shape loses any frame that lands during the key
    // derivation awaits (the "seen: (empty)" Tier-2 flake, reproduced under
    // CPU load 2026-07-19).
    let hsRes!: () => void;
    let hsRej!: (e: Error) => void;
    const hsDone = new Promise<void>((res, rej) => {
      hsRes = res;
      hsRej = rej;
    });
    // Mark hsDone's rejection handled the instant it exists. A wrong-code
    // connect (assert.rejects) opens then is closed by the relay immediately,
    // and under CPU load that close can reject hsDone DURING the
    // `await sealHandshake` below — before `await hsDone` is reached — so the
    // rejection would otherwise be unhandled and crash the whole test process
    // (the C.1 relay flake, root-caused 2026-07-23: 22/40 unhandled under
    // single-core stress, daemon provably not involved). `await hsDone` still
    // throws for the real caller; this only guarantees a handler always exists.
    hsDone.catch(() => {});
    const t = setTimeout(() => hsRej(new Error("handshake timed out")), 10_000);
    c.ws.on("close", () => {
      clearTimeout(t);
      hsRej(new Error("closed during handshake")); // no-op if already settled
    });
    c.ws.on("message", (data) => {
      c.recvChain = c.recvChain.then(async () => {
        if (!c.cipher) {
          try {
            const nonceD = await openHandshake(pair, "d", String(data));
            c.cipher = await frameCiphers(pair, nonceC, nonceD, "c");
            clearTimeout(t);
            hsRes();
          } catch (err) {
            clearTimeout(t);
            hsRej(err as Error);
          }
          return;
        }
        c.received.push(JSON.parse(await c.cipher.open(String(data))) as WireMsg);
        for (const w of c.wake.splice(0)) w();
      });
    });
    c.ws.send(await sealHandshake(pair, "c", nonceC));
    await hsDone;
    return c;
  }

  send(msg: ClientMsg) {
    this.sendChain = this.sendChain.then(async () => {
      this.ws.send(await this.cipher.seal(JSON.stringify(msg)));
    });
  }

  /** A frame the daemon must reject: sealed correctly, then corrupted. */
  async sendTampered() {
    const sealed = await this.cipher.seal(JSON.stringify({ type: "ping" }));
    const last = sealed.at(-1) === "A" ? "B" : "A";
    this.ws.send(sealed.slice(0, -1) + last);
  }

  /** Raw sealed frames, as fast as possible — for the relay's rate-limit test. */
  async blast(n: number) {
    for (let i = 0; i < n; i++) {
      this.ws.send(await this.cipher.seal(JSON.stringify({ type: "ping" })));
    }
  }

  waitFor(pred: (m: WireMsg) => boolean, label = "message", timeoutMs = 15_000): Promise<WireMsg> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for ${label}; seen: ${this.received.map((m) => m.type).join(",")}`,
          ),
        );
      }, timeoutMs);
      const scan = () => {
        while (this.cursor < this.received.length) {
          const m = this.received[this.cursor++];
          if (pred(m)) {
            clearTimeout(deadline);
            resolve(m);
            return;
          }
        }
        this.wake.push(scan);
      };
      scan();
    });
  }

  type(t: WireMsg["type"], timeoutMs?: number): Promise<WireMsg> {
    return this.waitFor((m) => m.type === t, t, timeoutMs);
  }

  mark(): number {
    return this.received.length;
  }

  close() {
    this.ws.close();
  }
}

export const waitForLog = (re: RegExp, timeoutMs = 10_000, daemon?: Daemon, fallback?: Daemon) =>
  new Promise<void>((resolve, reject) => {
    const dm = daemon ?? fallback;
    if (!dm) throw new Error("waitForLog needs a daemon");
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (re.test(dm.logs())) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`daemon log never matched ${re};\n${dm.logs()}`));
      }
    }, 50);
  });

/** Everything seq-stamped (i.e. the session's broadcast stream). */
export const broadcasts = (c: { received: WireMsg[] }) =>
  (c.received as Any[]).filter((m) => typeof m.seq === "number");
