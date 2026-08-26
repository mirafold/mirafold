import { spawn, type ChildProcess } from "node:child_process";

// The long-lived `codex app-server` transport: newline-delimited JSON-RPC
// over the child's stdio, the same framing jsonrpc-oneshot.ts uses for the
// catalog lookups — but this one lives as long as the session. Three traffic
// kinds cross it, and the client keeps them apart by shape: our requests
// (`id` + `method`, answered by a response carrying that id), the server's
// notifications (`method`, no id), and the server's OWN requests to us
// (`id` + `method` — approvals), which the session answers via `respond`.
// Nothing here knows what any method means; codex.ts owns the protocol.

export type JsonRpcId = number | string;

export type AppServerSpawn = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

export type AppServerExit = { code: number | null; signal: NodeJS.Signals | null };

export interface AppServerClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  respond(id: JsonRpcId, result: unknown): void;
  respondError(id: JsonRpcId, code: number, message: string): void;
  onNotification(cb: (method: string, params: unknown) => void): void;
  onServerRequest(cb: (id: JsonRpcId, method: string, params: unknown) => void): void;
  onExit(cb: (exit: AppServerExit) => void): void;
  readonly exited: boolean;
  /** The tail of the child's stderr — the engine's own words for a failure. */
  readonly stderrTail: string;
  kill(): void;
}

// A single JSON line larger than this is not a protocol message we can use;
// cut the process off rather than let one runaway line grow the daemon.
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;

export class AppServerExitedError extends Error {
  constructor(
    method: string,
    readonly exit: AppServerExit | undefined,
    stderrTail: string,
  ) {
    super(
      `codex app-server exited${exit ? ` (${exit.signal ?? `code ${exit.code}`})` : ""} before answering ${method}` +
        (stderrTail.trim() ? `: ${stderrTail.trim().split("\n").at(-1)}` : ""),
    );
  }
}

export function spawnAppServer(spec: AppServerSpawn): AppServerClient {
  const child: ChildProcess = spawn(spec.command, spec.args, {
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  let exited = false;
  let exitInfo: AppServerExit | undefined;
  let stderrTail = "";
  const pending = new Map<JsonRpcId, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notificationListeners = new Set<(method: string, params: unknown) => void>();
  const serverRequestListeners = new Set<(id: JsonRpcId, method: string, params: unknown) => void>();
  const exitListeners = new Set<(exit: AppServerExit) => void>();

  const write = (obj: object) => {
    if (exited || !child.stdin?.writable) return false;
    child.stdin.write(`${JSON.stringify(obj)}\n`);
    return true;
  };

  const failAll = () => {
    for (const [id, p] of [...pending]) {
      pending.delete(id);
      p.reject(new AppServerExitedError(p.method, exitInfo, stderrTail));
    }
  };

  const onLine = (line: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray non-JSON noise on stdout
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as { id?: JsonRpcId; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    if (m.method !== undefined && m.id !== undefined) {
      for (const cb of serverRequestListeners) cb(m.id, m.method, m.params);
      return;
    }
    if (m.method !== undefined) {
      for (const cb of notificationListeners) cb(m.method, m.params);
      return;
    }
    if (m.id === undefined) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message ?? `${p.method} failed`));
    else p.resolve(m.result);
  };

  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    if (buf.length > MAX_LINE_BYTES) {
      stderrTail += "\nmirafold: app-server line exceeded the size limit";
      child.kill("SIGKILL");
      buf = "";
      return;
    }
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  const finish = (exit: AppServerExit) => {
    if (exited) return;
    exited = true;
    exitInfo = exit;
    failAll();
    for (const cb of exitListeners) cb(exit);
  };
  child.on("error", (err) => {
    stderrTail = (stderrTail + `\n${err.message}`).slice(-STDERR_TAIL_BYTES);
    finish({ code: null, signal: null });
  });
  child.on("exit", (code, signal) => finish({ code, signal }));
  child.stdin?.on("error", () => {
    /* a closed pipe surfaces through the exit path */
  });

  return {
    request<T>(method: string, params?: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (exited) {
          reject(new AppServerExitedError(method, exitInfo, stderrTail));
          return;
        }
        const id = nextId++;
        pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
        if (!write(params === undefined ? { id, method } : { id, method, params })) {
          pending.delete(id);
          reject(new AppServerExitedError(method, exitInfo, stderrTail));
        }
      });
    },
    notify(method, params) {
      write(params === undefined ? { method } : { method, params });
    },
    respond(id, result) {
      write({ id, result });
    },
    respondError(id, code, message) {
      write({ id, error: { code, message } });
    },
    onNotification(cb) {
      notificationListeners.add(cb);
    },
    onServerRequest(cb) {
      serverRequestListeners.add(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
    },
    get exited() {
      return exited;
    },
    get stderrTail() {
      return stderrTail;
    },
    kill() {
      if (exited) return;
      child.kill();
      // A child that ignores SIGTERM still dies; unref so the timer never
      // holds the daemon open.
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 2_000).unref();
    },
  };
}
