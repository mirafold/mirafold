import { spawn, type IPty } from "node-pty";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * The `!` bash passthrough (Step 4.9). Commands run through a real PTY — not
 * a plain pipe — so `isatty()` is true and interactive programs (`sudo`,
 * `ssh`, y/n prompts) prompt normally; that interactivity is the whole point,
 * and it's what the terminal agents' own `!` can't do.
 */

export type BangProc = {
  /** Feed a line (or raw chars, e.g. \x03 for Ctrl-C) to the command's stdin. */
  write(data: string): void;
  kill(): void;
};

// Tier 1 renders the stream as plain text, so ANSI control sequences (colors,
// cursor movement, title-setting) are stripped server-side — the agent's
// injected context wants clean text too. A full terminal (xterm.js) that
// consumes the raw stream is Tier 2. CSI, OSC (BEL- or ST-terminated), and
// single-char ESC sequences; then CRLF/lone-CR normalize to LF (a progress
// bar's redraws stack as lines — acceptable for Tier 1).
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export function cleanPtyOutput(data: string): string {
  return data.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * The shell a `!` command runs in, per platform — terminal-faithful: a
 * Windows user's own terminal runs %ComSpec% (cmd.exe), never /bin/bash.
 * The win32 argv is a verbatim string (node-pty appends it unquoted), the
 * same `/d /s /c "…"` form node's own child_process uses for shell:true.
 * Exported for tests; `platform`/`env` are injectable for the same reason.
 */
export function bangShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: (command: string) => string[] | string } {
  if (platform === "win32") {
    return { file: env.ComSpec || "cmd.exe", args: (c) => `/d /s /c "${c}"` };
  }
  return { file: env.SHELL || "/bin/bash", args: (c) => ["-c", c] };
}

export function spawnBang(
  command: string,
  cwd: string,
  onData: (cleanText: string) => void,
  onExit: (exitCode: number | null) => void,
): BangProc {
  const { file, args } = bangShell();
  // A missing shell binary must throw HERE, identically on every platform:
  // win32 node-pty throws synchronously (ConPTY), but unix only fails after
  // the fork, inside the child — this check gives the caller one clean,
  // catchable failure mode instead of two (R.4f).
  if (isAbsolute(file) && !existsSync(file)) {
    throw new Error(`shell not found: ${file}`);
  }
  const proc: IPty = spawn(file, args(command), {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd,
    env: process.env as Record<string, string>,
  });
  proc.onData((d) => {
    const clean = cleanPtyOutput(d);
    if (clean) onData(clean);
  });
  // node-pty reports signal deaths as { exitCode: 0, signal: n } — surface
  // those as null so a killed command isn't mistaken for a clean exit.
  proc.onExit(({ exitCode, signal }) => onExit(signal ? null : exitCode));
  return {
    write(data: string) {
      proc.write(data);
    },
    kill() {
      proc.kill();
    },
  };
}
