import { spawn, type IPty } from "node-pty";

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

export function spawnBang(
  command: string,
  cwd: string,
  onData: (cleanText: string) => void,
  onExit: (exitCode: number | null) => void,
): BangProc {
  const shell = process.env.SHELL || "/bin/bash";
  const proc: IPty = spawn(shell, ["-c", command], {
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
