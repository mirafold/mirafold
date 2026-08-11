import { spawn } from "node:child_process";

// One-shot newline-delimited JSON-RPC against a spawned agent binary — the
// plumbing shared by codex-model-list.ts (`codex app-server`) and
// gemini-model-list.ts (`gemini --acp`): spawn, drive the exchange, settle
// once, kill the child. The caller owns the protocol (which messages to send,
// how to read the answer); this module owns the lifecycle.

export type OneShotSend = (obj: object) => void;

export function jsonRpcOneShot<T>(opts: {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  /** Error-message prefix naming the surface (e.g. "codex app-server"). */
  label: string;
  /** Kick off the exchange once the child is up. */
  start: (send: OneShotSend) => void;
  /** One parsed stdout JSON line; settle the promise via `finish`. */
  onMessage: (msg: unknown, send: OneShotSend, finish: (err: Error | null, result?: T) => void) => void;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.command, opts.args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    const finish = (err: Error | null, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      // A child that ignores SIGTERM still dies; unref so the timer never
      // holds the daemon open (2026-07-18 audit).
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      if (err) reject(err);
      else resolve(result as T);
    };
    const timer = setTimeout(() => finish(new Error(`${opts.label}: timed out`)), opts.timeoutMs);
    child.on("error", (err) => finish(err));
    child.on("exit", () => finish(new Error(`${opts.label}: exited before answering`)));

    const send: OneShotSend = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // stray non-JSON noise on stdout
        }
        // A bare scalar/`null` line is noise too — handing it to onMessage
        // would throw inside this stream listener and crash the whole daemon
        // (reproduced live, 2026-07-19 audit).
        if (typeof msg !== "object" || msg === null) continue;
        try {
          opts.onMessage(msg, send, finish);
        } catch (err) {
          // Provider catalogs are untrusted process output. A decoder bug or
          // malformed nested row must reject this one-shot lookup, never throw
          // out of a stream callback and terminate the Mirafold daemon.
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    try {
      opts.start(send);
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
