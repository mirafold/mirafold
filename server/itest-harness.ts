// Tier-2 harness (L.2b): spawns the real daemon as a child process and drives
// the real WebSocket — nothing in-process, so what's tested is exactly what
// ships: the Express auth gate, the ws upgrade path, the registry, and the
// mock adapter behind the AgentSession seam.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { ClientMsg, WireMsg } from "./protocol";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type Daemon = {
  port: number;
  /** Everything the daemon wrote to stdout+stderr so far. */
  logs: () => string;
  stop: () => Promise<void>;
};

/**
 * Start `server/index.ts` with every provider credential forced EMPTY so
 * credential detection routes all agents to the MockSession — a set (even
 * empty) env var beats `.env` under process.loadEnvFile(), verified. No test
 * may ever reach a metered engine. GENUI_TOKEN defaults to disabled; auth
 * tests pass their own.
 */
export function startDaemon(env: Record<string, string> = {}): Promise<Daemon> {
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
      CODEX_HOME: path.join(ROOT, "itest-no-codex-home"), // no auth.json here
      GENUI_TOKEN: "",
      GENUI_RELAY_URL: "", // no dial-out unless a relay test asks for it
      GENUI_RELAY_CODE: "",
      // Random base + the daemon's own EADDRINUSE walk absorbs collisions
      // between parallel test files; the real port is read off stdout.
      PORT: String(3900 + Math.floor(Math.random() * 90)),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d: Buffer) => (log += d));
  child.stderr.on("data", (d: Buffer) => (log += d));
  return new Promise<Daemon>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`daemon did not start in 15s; log:\n${log}`)),
      15_000,
    );
    const poll = setInterval(() => {
      const m = log.match(/server on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (!m) return;
      clearTimeout(deadline);
      clearInterval(poll);
      resolve({
        port: Number(m[1]),
        logs: () => log,
        stop: () =>
          new Promise<void>((done) => {
            // SIGKILL fallback: a daemon that shrugs off SIGTERM must not
            // wedge the whole suite in an after() hook.
            const hard = setTimeout(() => child.kill("SIGKILL"), 3_000);
            child.once("exit", () => {
              clearTimeout(hard);
              done();
            });
            child.kill();
          }),
      });
    }, 50);
  });
}

/**
 * A viewport: one ws connection. `received` keeps every frame for whole-stream
 * assertions; `waitFor` consumes forward from an internal cursor so sequential
 * grammar checks read like the stream itself.
 */
export class TestClient {
  ws: WebSocket;
  received: WireMsg[] = [];
  closed: Promise<{ code: number }>;
  private cursor = 0;
  private wake: (() => void)[] = [];

  constructor(
    port: number,
    opts: { token?: string; origin?: string; cookie?: string; query?: string } = {},
  ) {
    // `query` is used verbatim (the relay tests pass ?code=…); `token` keeps
    // its dedicated shorthand for the auth tests.
    const q =
      opts.query ??
      (opts.token !== undefined ? `?token=${encodeURIComponent(opts.token)}` : "");
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws${q}`, {
      headers: {
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
    });
    this.ws.on("message", (d) => {
      this.received.push(JSON.parse(String(d)) as WireMsg);
      for (const w of this.wake.splice(0)) w();
    });
    this.closed = new Promise((res) => {
      this.ws.on("close", (code) => res({ code }));
      this.ws.on("error", () => res({ code: -1 })); // rejected handshake
    });
  }

  /** Resolves on open; rejects if the server refuses the handshake. */
  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on("open", resolve);
      this.ws.on("error", (err) => reject(err));
    });
  }

  send(msg: ClientMsg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Raw frame — for the payload-cap test only. */
  sendRaw(data: string) {
    this.ws.send(data);
  }

  /** Next frame (from the cursor) matching `pred`; advances the cursor past it. */
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

  /** Index into `received` right now — slice from here to bound one turn. */
  mark(): number {
    return this.received.length;
  }

  close() {
    this.ws.close();
  }
}

/** Open a client, wait for the `agents` hello, create a session on `agent`. */
export async function createSession(
  port: number,
  agent = "claude-code",
): Promise<{ client: TestClient; sessionId: string }> {
  const client = new TestClient(port);
  await client.opened();
  await client.type("agents");
  client.send({ type: "create", agent } as ClientMsg);
  const created = (await client.type("session_created")) as WireMsg & { sessionId: string };
  return { client, sessionId: created.sessionId };
}
