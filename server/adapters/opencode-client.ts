import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { envInt } from "../env";
import type { OpenCodeProviderEntry } from "../provider-policy";
import { errText } from "./types";

/** One event off `GET /event` — `properties` is the engine's payload,
 *  deliberately loose: shapes are locked by the OC.0 live capture (see
 *  opencode.spike.md), and the published SDK types demonstrably drift from
 *  the live server (permission.asked vs permission.updated), so we type at
 *  the seam we verified rather than trust a generated union. */
export type OpenCodeEvent = { type: string; properties: Record<string, unknown> };

/** Remove the minted per-session server password from a stderr tail before it
 *  can ride into an error WireMsg (broadcast + checkpointed). Pure and
 *  exported so the redaction is testable without poking a live transport
 *  (audit 2026-08-13). `scrub()` in the log layer catches Basic/sk- shapes;
 *  this removes the exact bare-hex secret we generated, which scrub can't. */
export const redactSecret = (tail: string, secret: string): string =>
  secret ? tail.split(secret).join("[redacted]") : tail;

/** The transport seam between OpenCodeSession and a live `opencode serve` —
 *  swapped for a fake in Tier-1 tests. */
export interface OpenCodeTransport {
  /** Spawn + health-check the server and subscribe the event stream.
   *  `onDied` fires if the engine PROCESS exits after a successful start —
   *  without it a mid-turn crash left the session busy-wedged forever
   *  (bughunt round 2); the transport clears its own start latch so the
   *  next start() respawns fresh. */
  start(onEvent: (ev: OpenCodeEvent) => void, onDied?: (detail: string) => void): Promise<void>;
  createSession(): Promise<{ id: string }>;
  /** Fork preserves the conversation while giving interrupt recovery a new
   *  session identity; late events from the abandoned id can then be ignored. */
  forkSession(id: string): Promise<{ id: string }>;
  sessionExists(id: string): Promise<boolean>;
  /** POST /session/:id/prompt_async — resolves once the engine ACCEPTED the
   *  prompt; the turn itself streams back over events. */
  prompt(sessionID: string, body: Record<string, unknown>): Promise<void>;
  abort(sessionID: string): Promise<void>;
  /** The engine's connected-provider catalog, STRIPPED to classification
   *  fields — the raw endpoint exposes stored secrets (`key`), which must
   *  never travel past this seam. */
  providerCatalog(): Promise<OpenCodeProviderEntry[]>;
  /** The user's own configured default model (`model` in their opencode
   *  config), `provider/model` form; undefined when they set none. */
  configModel(): Promise<string | undefined>;
  agentCatalog(): Promise<OpenCodeAgentEntry[]>;
  commandCatalog(): Promise<OpenCodeCommandEntry[]>;
  modelCatalog(): Promise<OpenCodeModelEntry[]>;
  /** Run an engine command (`/init`, a custom command, …) as this session's
   *  turn — the engine's own dispatcher, not prompt text. */
  command(
    sessionID: string,
    name: string,
    args: string,
    opts: { model?: string; agent?: string },
  ): Promise<void>;
  // Session-agnostic since SA.3 (POST /permission/{requestID}/reply — the
  // modern endpoint): a SUBAGENT session's ask is answered by the same call,
  // no session id required. The per-session endpoint it replaces is marked
  // deprecated in the live 1.18.18 spec (and, measured in the SA.0 probe,
  // never validated session↔permission ownership anyway).
  replyPermission(
    permissionID: string,
    // Never "always": that would persist an approval into the user's own
    // OpenCode state, which is theirs to grant in their own tool.
    response: "once" | "reject",
  ): Promise<void>;
  close(): void;
}

const START_DEADLINE_MS = envInt("MIRAFOLD_OPENCODE_START_TIMEOUT_MS", 20_000);
// Session-control endpoints are finite bookkeeping calls. A wedged engine
// must not leave an abort/fork/create fetch alive forever; prompt_async and
// command intentionally do NOT inherit this bound because they have their own
// turn envelope and engine-event completion semantics.
const CONTROL_REQUEST_TIMEOUT_MS = envInt("MIRAFOLD_OPENCODE_CONTROL_TIMEOUT_MS", 10_000);

/** One agent from `GET /agent` — `hidden: true` marks the engine's internal
 *  primaries (compaction/summary/title), which no picker should offer. */
export type OpenCodeAgentEntry = {
  name: string;
  mode: "primary" | "subagent";
  hidden?: boolean;
  description?: string;
};

/** One command from `GET /command` (built-ins + the user's own custom
 *  commands) — dispatched faithfully via `POST /session/:id/command`. */
export type OpenCodeCommandEntry = { name: string; description?: string };

/** One model of a CONNECTED provider (`GET /config/providers`), the user's
 *  own whitelist/blacklist already applied server-side. */
export type OpenCodeModelEntry = { providerID: string; modelID: string; name?: string };

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
  // The per-session basic-auth secret we mint — redacted from any stderr
  // that rides into an error WireMsg (audit 2026-08-13: opencode's own
  // stderr is engine-controlled; scrub() catches Basic/Bearer/sk- shapes
  // but not this bare hex, so redact the exact value we know).
  private authSecret = "";
  // One spawn per instance, even under concurrent/retried start() calls: a
  // re-entered start orphaned the previous `opencode serve` (only the latest
  // child was killed on close) and doubled the event pump (bughunt
  // 2026-08-13). A FAILED start kills its child and clears the latch so a
  // later call may retry with a fresh spawn.
  private starting?: Promise<void>;

  constructor(
    private readonly options: {
      bin: string;
      cwd: string;
      /** Serialized into OPENCODE_CONFIG_CONTENT — the additive, file-free
       *  injection path (trust rule: no user-owned config is read differently,
       *  written, or created). A user's own OPENCODE_CONFIG_CONTENT env is
       *  superseded for sessions we spawn; their config FILES still load. */
      configContent: Record<string, unknown>;
      /** Test seam: the spawned engine's base environment (default
       *  process.env). The live itest jails HOME/XDG here so a REAL engine
       *  run never reads or writes the developer's own opencode state. */
      env?: Record<string, string | undefined>;
    },
  ) {}

  /** The stderr tail with our own minted secret removed, before it ever
   *  reaches an error WireMsg (which is broadcast AND checkpointed). */
  private safeStderr(): string {
    return redactSecret(this.stderrTail.trim().slice(-300), this.authSecret);
  }

  start(onEvent: (ev: OpenCodeEvent) => void, onDied?: (detail: string) => void): Promise<void> {
    this.starting ??= this.spawnAndConnect(onEvent, onDied).catch((err) => {
      this.child?.kill();
      this.child = undefined;
      this.starting = undefined;
      throw err;
    });
    return this.starting;
  }

  // Bumped per spawn AND per observed death: a stale event pump must stop
  // rather than reconnect forever against a dead (or replacement) server.
  private generation = 0;

  private async spawnAndConnect(
    onEvent: (ev: OpenCodeEvent) => void,
    onDied?: (detail: string) => void,
  ): Promise<void> {
    const generation = ++this.generation;
    const port = await freePort();
    // The port is loopback-bound but otherwise open to any local process;
    // basic auth with a per-session secret closes that (spike §surface).
    const password = randomBytes(24).toString("hex");
    this.authSecret = password;
    this.base = `http://127.0.0.1:${port}`;
    this.auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    const child = spawn(
      this.options.bin,
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        cwd: this.options.cwd,
        env: {
          ...(this.options.env ?? process.env),
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
            (this.stderrTail ? `: ${this.safeStderr()}` : ""),
        );
      try {
        // Per-attempt abort is load-bearing, not hygiene: a connection made
        // in the window between the port binding and the app serving is never
        // answered, and awaiting it forever wedges start() past the deadline
        // (observed live, OC.2 probe 2026-08-13). Abandon and re-poll.
        const res = await fetch(`${this.base}/global/health`, {
          headers: { authorization: this.auth },
          signal: AbortSignal.timeout(1_000),
        });
        if (res.ok) break;
      } catch {
        // not up yet (or the wedged-connection abort above)
      }
      if (Date.now() > deadline)
        throw new Error(`opencode serve did not become healthy within ${START_DEADLINE_MS}ms`);
      await delay(250);
    }
    await this.waitForInjectedMcp(deadline);
    // Startup succeeded — from here, a child exit is a CRASH the session
    // must hear about (before this, the health loop owns exit reporting).
    child.once("exit", (code, signal) => {
      if (this.closed || this.generation !== generation) return;
      this.generation += 1; // stop this spawn's pump
      this.starting = undefined; // the next start() respawns fresh
      this.child = undefined;
      onDied?.(
        `opencode serve exited unexpectedly (${signal ?? `code ${code}`})` +
          (this.stderrTail ? `: ${this.safeStderr()}` : ""),
      );
    });
    void this.pumpEvents(onEvent, generation);
  }

  /** The engine's tool registry (and MCP connections) initialize lazily; a
   *  prompt sent immediately after health races it and the model is offered
   *  ZERO tools — observed live (OC.2 probe: request 1 carried no tools, so
   *  the scripted render call bounced). The injected render server reporting
   *  "connected" is the readiness signal start() actually promises. On
   *  deadline we proceed anyway: the engine still converses, renders just
   *  arrive with a later turn — degraded, not dead. */
  private async waitForInjectedMcp(deadline: number): Promise<void> {
    const injected = Object.keys((this.options.configContent["mcp"] as object | undefined) ?? {});
    if (!injected.length) return;
    while (Date.now() <= deadline && !this.closed) {
      try {
        const res = await fetch(`${this.base}/mcp`, {
          headers: { authorization: this.auth },
          signal: AbortSignal.timeout(1_000),
        });
        if (res.ok) {
          const statuses = (await res.json()) as Record<string, { status?: string }>;
          if (injected.every((name) => statuses[name]?.status === "connected")) return;
        }
      } catch {
        // poll again
      }
      await delay(250);
    }
  }

  /** Read the SSE stream for this SPAWN's life, reconnecting on drops. */
  private async pumpEvents(onEvent: (ev: OpenCodeEvent) => void, generation: number): Promise<void> {
    while (!this.closed && this.generation === generation) {
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
      if (!this.closed && this.generation === generation) await delay(500);
    }
  }

  private async request(
    pathname: string,
    init?: RequestInit,
    timeoutMs?: number,
  ): Promise<Response> {
    const res = await fetch(`${this.base}${pathname}`, {
      ...init,
      ...(init?.signal || timeoutMs === undefined
        ? {}
        : { signal: AbortSignal.timeout(timeoutMs) }),
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
    const res = await this.request(
      "/session",
      { method: "POST", body: "{}" },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    return (await res.json()) as { id: string };
  }

  async forkSession(id: string): Promise<{ id: string }> {
    const res = await this.request(
      `/session/${encodeURIComponent(id)}/fork`,
      { method: "POST", body: "{}" },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    return (await res.json()) as { id: string };
  }

  async sessionExists(id: string): Promise<boolean> {
    try {
      await this.request(
        `/session/${encodeURIComponent(id)}`,
        undefined,
        CONTROL_REQUEST_TIMEOUT_MS,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** The parsed `/config/providers` list — the raw endpoint also returns the
   *  user's stored secrets (`key`), so every consumer maps through here and
   *  only the fields it names ever leave this class. */
  private async fetchProviders(): Promise<Record<string, unknown>[]> {
    const res = await this.request("/config/providers");
    const data = (await res.json()) as { providers?: unknown };
    const list = Array.isArray(data.providers) ? data.providers : [];
    return list.map((raw) => (raw ?? {}) as Record<string, unknown>);
  }

  async providerCatalog(): Promise<OpenCodeProviderEntry[]> {
    return (await this.fetchProviders()).map((p) => {
      const options = (p["options"] ?? {}) as Record<string, unknown>;
      // Deliberate strip: `p.key` is the user's raw stored secret. Only the
      // classification facts leave this method (provider-policy.ts shape).
      return {
        id: String(p["id"]),
        source: String(p["source"]) as OpenCodeProviderEntry["source"],
        ...(typeof options["apiKey"] === "string" ? { apiKeyOption: options["apiKey"] } : {}),
      };
    });
  }

  async configModel(): Promise<string | undefined> {
    const res = await this.request("/config");
    const config = (await res.json()) as { model?: unknown };
    return typeof config.model === "string" && config.model ? config.model : undefined;
  }

  async agentCatalog(): Promise<OpenCodeAgentEntry[]> {
    const res = await this.request("/agent");
    const list = (await res.json()) as Record<string, unknown>[];
    return list.map((a) => ({
      name: String(a["name"]),
      mode: a["mode"] === "subagent" ? "subagent" : "primary",
      ...(a["hidden"] === true ? { hidden: true } : {}),
      ...(typeof a["description"] === "string" && a["description"]
        ? { description: a["description"] }
        : {}),
    }));
  }

  async commandCatalog(): Promise<OpenCodeCommandEntry[]> {
    const res = await this.request("/command");
    const list = (await res.json()) as Record<string, unknown>[];
    return list.map((c) => ({
      name: String(c["name"]),
      ...(typeof c["description"] === "string" && c["description"]
        ? { description: c["description"] }
        : {}),
    }));
  }

  async modelCatalog(): Promise<OpenCodeModelEntry[]> {
    return (await this.fetchProviders()).flatMap((p) => {
      const providerID = String(p["id"]);
      return Object.entries((p["models"] ?? {}) as Record<string, unknown>).map(
        ([modelID, model]) => {
          const name = ((model ?? {}) as Record<string, unknown>)["name"];
          return {
            providerID,
            modelID,
            ...(typeof name === "string" && name ? { name } : {}),
          };
        },
      );
    });
  }

  async command(
    sessionID: string,
    name: string,
    args: string,
    opts: { model?: string; agent?: string },
  ): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({
        command: name,
        ...(args ? { arguments: args } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.agent ? { agent: opts.agent } : {}),
      }),
    });
  }

  async prompt(sessionID: string, body: Record<string, unknown>): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async abort(sessionID: string): Promise<void> {
    await this.request(
      `/session/${encodeURIComponent(sessionID)}/abort`,
      {
        method: "POST",
        body: "{}",
      },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
  }

  async replyPermission(permissionID: string, response: "once" | "reject"): Promise<void> {
    await this.request(`/permission/${encodeURIComponent(permissionID)}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply: response }),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child?.kill();
  }
}
