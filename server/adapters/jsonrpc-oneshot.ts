import { spawn } from "node:child_process";
import { envWithout } from "./types";

// Provider catalog replies are normally tens of kilobytes. Bound cumulative
// stdout as it crosses the process boundary so a corrupt binary cannot retain
// arbitrary data during the otherwise time-bounded lookup.
const ONE_SHOT_STDOUT_MAX_BYTES = 1_000_000;
const ONE_SHOT_STDERR_MAX_BYTES = 4_000;

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
  /** A caller-prepared child environment; must exclude daemon credentials. */
  env?: Record<string, string>;
  /** Preserve a bounded diagnostic tail when this process exits before replying. */
  captureStderr?: boolean;
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
      env: opts.env ?? envWithout(), // never the daemon's own secrets
      stdio: ["pipe", "pipe", opts.captureStderr ? "pipe" : "ignore"],
    });
    // Optional stderr widens Node's overload; stdin/stdout are fixed pipes.
    const stdin = child.stdin!;
    const stdout = child.stdout!;
    let settled = false;
    let stderr = Buffer.alloc(0);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk.subarray(-ONE_SHOT_STDERR_MAX_BYTES)])
        .subarray(-ONE_SHOT_STDERR_MAX_BYTES);
    });
    const finish = (err: Error | null, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      // A child that ignores SIGTERM still dies; unref so the timer never
      // holds the daemon open.
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      if (err) reject(err);
      else resolve(result as T);
    };
    const timer = setTimeout(() => finish(new Error(`${opts.label}: timed out`)), opts.timeoutMs);
    child.on("error", (err) => finish(err));
    stdin.on("error", (err: NodeJS.ErrnoException) => {
      // An early auth exit can close stdin before its stderr has drained.
      if (opts.captureStderr && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
      finish(err);
    });
    child.on(opts.captureStderr ? "close" : "exit", () => {
      const diagnostic = stderr.toString("utf8").trim();
      finish(new Error(`${opts.label}: exited before answering${diagnostic ? `: ${diagnostic}` : ""}`));
    });

    const send: OneShotSend = (obj) => stdin.write(`${JSON.stringify(obj)}\n`);
    let buf = "";
    let stdoutBytes = 0;
    stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > ONE_SHOT_STDOUT_MAX_BYTES) {
        finish(new Error(`${opts.label}: stdout exceeded ${ONE_SHOT_STDOUT_MAX_BYTES} bytes`));
        return;
      }
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
        // would throw inside this stream listener and crash the whole daemon.
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
