// Tier-2 harness (L.2b): spawns the real daemon as a child process and drives
// the real WebSocket — nothing in-process, so what's tested is exactly what
// ships: the Express auth gate, the ws upgrade path, the registry, and the
// mock adapter behind the AgentSession seam.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { ClientMsg, WireMsg } from "../protocol";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Daemon = {
  port: number;
  /** Everything the daemon wrote to stdout+stderr so far. */
  logs: () => string;
  /** Wait until the accumulated log matches. Use this instead of asserting
   *  logs() right after a wire event: the log line rides the child's stdout
   *  PIPE while the event rides the WebSocket — independent channels, and
   *  under CPU load the frame routinely beats the pipe chunk into this
   *  process (the C.1 runner flake, root-caused 2026-07-23). */
  waitForLog: (re: RegExp, label: string, timeoutMs?: number) => Promise<void>;
  stop: () => Promise<void>;
};

/**
 * Every provider credential forced EMPTY — a set (even empty) env var beats
 * `.env` under process.loadEnvFile(), verified — so credential detection
 * routes all agents to the MockSession. No test may ever reach a metered
 * engine. Shared with launcher.e2e.ts, which spawns the launcher (not the
 * daemon) and so can't use startDaemon but must scrub the same credentials.
 * PORT is deliberately NOT here: each spawn randomizes its own.
 */
export const SCRUBBED_CREDENTIAL_ENV = {
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_BASE_URL: "",
  OPENAI_API_KEY: "",
  GEMINI_API_KEY: "",
  GOOGLE_API_KEY: "",
  CODEX_HOME: path.join(ROOT, "itest-no-codex-home"), // no auth.json here
  // OpenCode detects LIVE from the binary alone (the Zen gateway, OC.4c), so
  // a dev machine with opencode installed would flip the card ready and a
  // careless click could spawn a real engine. An absolute-but-missing
  // override reads as NOT installed (types.ts installedAgentBin) — the mock
  // stays forced everywhere, like the credential scrubs above.
  OPENCODE_BIN: path.join(ROOT, "itest-no-opencode", "opencode"),
  MIRAFOLD_LOG_FILE: "", // never write the real flight-recorder file from tests
  MIRAFOLD_SESSION_DIR: path.join(os.tmpdir(), `mirafold-itest-${process.pid}`),
  // R.4b made a `claude` subscription login count as live credentials —
  // point the check at an empty dir so a logged-in dev machine (the
  // usual case) still runs every test against the mock.
  CLAUDE_CONFIG_DIR: path.join(ROOT, "itest-no-claude-home"),
  MIRAFOLD_TOKEN: "",
  MIRAFOLD_RELAY_URL: "", // no dial-out unless a relay test asks for it
  MIRAFOLD_RELAY_CODE: "",
};

/**
 * Start `server/index.ts` with the credential scrub above applied.
 * MIRAFOLD_TOKEN defaults to disabled; auth tests pass their own.
 */
export function startDaemon(env: Record<string, string> = {}): Promise<Daemon> {
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...SCRUBBED_CREDENTIAL_ENV,
      // R.5's paid-tier settings, scrubbed like credentials: a set APP_URL
      // points pairing QRs at the hosted app instead of the daemon under
      // test, and license/entitlement config makes the daemon call the real
      // billing backend. A dev shell exporting these (live-testing the paid
      // path) must not change what any test observes.
      MIRAFOLD_APP_URL: "",
      MIRAFOLD_LICENSE_KEY: "",
      MIRAFOLD_ENTITLEMENT_TOKEN: "",
      MIRAFOLD_ENTITLEMENT_URL: "",
      // N.3: never probe the real well-known ports — a dev machine's actual
      // Ollama must not leak into an itest's `backends`. A discovery test
      // passes its fixture server via MIRAFOLD_LOCAL_ENDPOINTS.
      MIRAFOLD_LOCAL_DISCOVERY: "off",
      MIRAFOLD_LOCAL_ENDPOINTS: "",
      // A refresh_agents must re-probe on the test's clock, not the poll
      // TTL's — fixture servers appear/disappear mid-test and the
      // assertions watch for exactly that.
      MIRAFOLD_LOCAL_PROBE_TTL_MS: "0",
      // Session checkpoints are production state. Every daemon test gets an
      // isolated temp store unless a recovery test deliberately supplies one.
      MIRAFOLD_SESSION_DIR: path.join(
        os.tmpdir(),
        `mirafold-itest-${process.pid}-${randomUUID()}`,
      ),
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
    // A daemon that exits before it listens (a syntax error, a refused
    // port, a missing module) must fail this promise NOW, with its log —
    // not after the 15 s deadline with "did not start".
    child.once("exit", (code, signal) => {
      clearInterval(poll);
      clearTimeout(deadline);
      reject(new Error(`daemon exited (${code ?? signal}) before listening; log:\n${log}`));
    });
    const deadline = setTimeout(() => {
      // A failed boot must not leak: the poll would fire for the rest of the
      // process, and the child — maybe listening but never having printed —
      // would squat its port for every test after this one (2026-07-28 fix).
      clearInterval(poll);
      child.kill("SIGKILL");
      reject(new Error(`daemon did not start in 15s; log:\n${log}`));
    }, 15_000);
    const poll = setInterval(() => {
      const m = log.match(/server on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (!m) return;
      clearTimeout(deadline);
      clearInterval(poll);
      resolve({
        port: Number(m[1]),
        logs: () => log,
        waitForLog: (re, label, timeoutMs = 10_000) =>
          new Promise<void>((res, rej) => {
            const t0 = Date.now();
            const check = setInterval(() => {
              if (re.test(log)) {
                clearInterval(check);
                res();
              } else if (Date.now() - t0 > timeoutMs) {
                clearInterval(check);
                rej(new Error(`waitForLog(${label}): no match for ${re} in ${timeoutMs}ms`));
              }
            }, 20);
          }),
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
 * Real git against a temp fixture, isolated from the machine's config
 * (identity via -c, global/system config nulled so signing hooks etc. can't
 * leak in). Suites that call this assume a git binary; the daemon's own
 * degrade path for a missing binary is covered at Tier 1.
 */
export const fixtureGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: "pipe",
  });

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
    opts: { token?: string; origin?: string; cookie?: string } = {},
  ) {
    const q = opts.token !== undefined ? `?token=${encodeURIComponent(opts.token)}` : "";
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

/** Open a client, wait for the `agents` hello, create a session on `agent`
 *  (in `cwd` when given — the way a browser test seeds a session AT a
 *  fixture the UI has no picker for). */
export async function createSession(
  port: number,
  agent = "claude-code",
  options: { cwd?: string; token?: string } = {},
): Promise<{ client: TestClient; sessionId: string }> {
  const client = new TestClient(port, options.token !== undefined ? { token: options.token } : undefined);
  await client.opened();
  await client.type("agents");
  client.send({ type: "create", agent, ...(options.cwd ? { cwd: options.cwd } : {}) } as ClientMsg);
  const created = (await client.type("session_created")) as WireMsg & { sessionId: string };
  return { client, sessionId: created.sessionId };
}

/** Open a client and attach it to an existing session (optionally resuming
 *  from `afterSeq`); hands back the `session_created` ack for its
 *  `sessionId`/`resumed` fields. */
export async function attachSession(
  port: number,
  sessionId: string,
  afterSeq?: number,
): Promise<{ client: TestClient; created: WireMsg & Record<string, any> }> {
  const client = new TestClient(port);
  await client.opened();
  await client.type("agents");
  client.send({ type: "attach", sessionId, ...(afterSeq !== undefined ? { afterSeq } : {}) } as never);
  const created = (await client.type("session_created")) as WireMsg & Record<string, any>;
  return { client, created };
}

/** Everything seq-stamped a client has seen (i.e. the session's broadcast stream). */
export const broadcasts = (c: { received: WireMsg[] }) =>
  (c.received as (WireMsg & Record<string, any>)[]).filter((m) => typeof m.seq === "number");

/** Drop the attach-replay stamp for content comparisons: frames replayed to
 *  a late joiner carry `replay: true` by design (2026-07-29), while the
 *  CONTENT must still mirror the live stream byte for byte. */
export const stripReplay = (msgs: WireMsg[]) =>
  msgs.map(({ replay: _replay, ...m }) => m as WireMsg);
