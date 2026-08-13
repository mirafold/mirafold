import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { envInt } from "../env";
import { errText } from "./types";

/** One event off `GET /event` — `properties` is the engine's payload,
 *  deliberately loose: shapes are locked by the OC.0 live capture (see
 *  opencode.spike.md), and the published SDK types demonstrably drift from
 *  the live server (permission.asked vs permission.updated), so we type at
 *  the seam we verified rather than trust a generated union. */
export type OpenCodeEvent = { type: string; properties: Record<string, unknown> };

/** The transport seam between OpenCodeSession and a live `opencode serve` —
 *  swapped for a fake in Tier-1 tests. */
export interface OpenCodeTransport {
  /** Spawn + health-check the server and subscribe the event stream. */
  start(onEvent: (ev: OpenCodeEvent) => void): Promise<void>;
  createSession(): Promise<{ id: string }>;
  sessionExists(id: string): Promise<boolean>;
  /** POST /session/:id/prompt_async — resolves once the engine ACCEPTED the
   *  prompt; the turn itself streams back over events. */
  prompt(sessionID: string, body: Record<string, unknown>): Promise<void>;
  abort(sessionID: string): Promise<void>;
  replyPermission(
    sessionID: string,
    permissionID: string,
    // Never "always": that would persist an approval into the user's own
    // OpenCode state, which is theirs to grant in their own tool.
    response: "once" | "reject",
  ): Promise<void>;
  close(): void;
}

const START_DEADLINE_MS = envInt("MIRAFOLD_OPENCODE_START_TIMEOUT_MS", 20_000);

/** An ephemeral localhost port. Classic listen-then-close: the tiny race
 *  window before opencode binds is acceptable on loopback. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port assigned")),
      );
    });
  });
}

/**
 * Production transport: one `opencode serve` per session (the server is
 * project-scoped by cwd), driven raw over its documented HTTP + SSE surface.
 * Deliberately no `@opencode-ai/sdk` (decision finalized at OC.1): the live
 * probe caught the generated types drifting from the real server, our surface
 * is six endpoints + an SSE parse, and zero dependencies beats stale types —
 * the shapes we rely on are the ones OC.0 captured.
 */
export class OpenCodeServerProcess implements OpenCodeTransport {
  private child?: ChildProcess;
  private base = "";
  private auth = "";
  private closed = false;
  private stderrTail = "";

  constructor(
    private readonly options: {
      bin: string;
      cwd: string;
      /** Serialized into OPENCODE_CONFIG_CONTENT — the additive, file-free
       *  injection path (trust rule: no user-owned config is read differently,
       *  written, or created). A user's own OPENCODE_CONFIG_CONTENT env is
       *  superseded for sessions we spawn; their config FILES still load. */
      configContent: Record<string, unknown>;
    },
  ) {}

  async start(onEvent: (ev: OpenCodeEvent) => void): Promise<void> {
    const port = await freePort();
    // The port is loopback-bound but otherwise open to any local process;
    // basic auth with a per-session secret closes that (spike §surface).
    const password = randomBytes(24).toString("hex");
    this.base = `http://127.0.0.1:${port}`;
    this.auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    const child = spawn(
      this.options.bin,
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(this.options.configContent),
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    this.child = child;
    let spawnError: string | undefined;
    child.once("error", (err) => (spawnError = errText(err)));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });
    const deadline = Date.now() + START_DEADLINE_MS;
    for (;;) {
      if (this.closed) throw new Error("session closed during startup");
      if (spawnError) throw new Error(`could not start opencode (${this.options.bin}): ${spawnError}`);
      if (child.exitCode !== null)
        throw new Error(
          `opencode serve exited (code ${child.exitCode}) before becoming healthy` +
            (this.stderrTail ? `: ${this.stderrTail.trim().slice(-300)}` : ""),
        );
      try {
        const res = await fetch(`${this.base}/global/health`, {
          headers: { authorization: this.auth },
        });
        if (res.ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline)
        throw new Error(`opencode serve did not become healthy within ${START_DEADLINE_MS}ms`);
      await delay(250);
    }
    void this.pumpEvents(onEvent);
  }

  /** Read the SSE stream for the server's whole life, reconnecting on drops. */
  private async pumpEvents(onEvent: (ev: OpenCodeEvent) => void): Promise<void> {
    while (!this.closed) {
      try {
        const res = await fetch(`${this.base}/event`, { headers: { authorization: this.auth } });
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = chunk.split("\n").find((line) => line.startsWith("data: "));
            if (!data) continue;
            try {
              onEvent(JSON.parse(data.slice(6)) as OpenCodeEvent);
            } catch {
              // one unparseable frame must not kill the stream
            }
          }
        }
      } catch {
        // fall through to reconnect
      }
      if (!this.closed) await delay(500);
    }
  }

  private async request(pathname: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.base}${pathname}`, {
      ...init,
      headers: {
        authorization: this.auth,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`opencode ${pathname} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    return res;
  }

  async createSession(): Promise<{ id: string }> {
    const res = await this.request("/session", { method: "POST", body: "{}" });
    return (await res.json()) as { id: string };
  }

  async sessionExists(id: string): Promise<boolean> {
    try {
      await this.request(`/session/${encodeURIComponent(id)}`);
      return true;
    } catch {
      return false;
    }
  }

  async prompt(sessionID: string, body: Record<string, unknown>): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async abort(sessionID: string): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionID)}/abort`, {
      method: "POST",
      body: "{}",
    });
  }

  async replyPermission(
    sessionID: string,
    permissionID: string,
    response: "once" | "reject",
  ): Promise<void> {
    await this.request(
      `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}`,
      { method: "POST", body: JSON.stringify({ response }) },
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child?.kill();
  }
}
