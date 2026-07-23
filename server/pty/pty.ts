// @lydell/node-pty over upstream node-pty (2026-07-23): identical API, but
// prebuilt binaries ship as platform optionalDependencies (the esbuild
// pattern) — no install script, so current npm's script-blocking can't
// break the install, and users need no compiler toolchain. Upstream's
// postinstall compile crashed the daemon at first boot on default npm.
import { spawn, type IPty } from "@lydell/node-pty";
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

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

// The cwd handoff: where did the shell END UP? An EXIT trap writes the final
// working directory to a daemon-owned file (out of band — never pollutes the
// PTY stream), so `cd` persists across `!` commands the way it does in a
// terminal harness. Only shells whose trap/pwd syntax is known get the
// wrapper; an exotic $SHELL would otherwise error visibly on EVERY command,
// so those skip capture and their cwd simply doesn't move. win32 (cmd.exe)
// has no equivalent that preserves the exit code — skipped too. A command
// that `exec`s away or re-traps EXIT loses the handoff; the caller treats a
// missing file as "didn't move".
const CWD_CAPTURE_SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh", "mksh", "fish"]);
export const CWD_FILE_ENV = "MIRAFOLD_BANG_CWD_FILE";

/** The trap line prefixed to the user's command, or null when this shell
 *  can't capture safely. The file path rides in $MIRAFOLD_BANG_CWD_FILE so
 *  no path ever needs quoting into the command string. */
export function cwdCapturePrefix(
  file: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "win32" || !CWD_CAPTURE_SHELLS.has(basename(file))) return null;
  // Newline separator, not `;` — the user command may open with a comment.
  return `trap 'pwd -P > "$${CWD_FILE_ENV}"' EXIT\n`;
}

export function spawnBang(
  command: string,
  cwd: string,
  onData: (cleanText: string) => void,
  onExit: (exitCode: number | null) => void,
  cwdFile?: string,
): BangProc {
  const { file, args } = bangShell();
  const prefix = cwdFile ? cwdCapturePrefix(file) : null;
  // A missing shell binary must throw HERE, identically on every platform:
  // win32 node-pty throws synchronously (ConPTY), but unix only fails after
  // the fork, inside the child — this check gives the caller one clean,
  // catchable failure mode instead of two (R.4f).
  if (isAbsolute(file) && !existsSync(file)) {
    throw new Error(`shell not found: ${file}`);
  }
  const proc: IPty = spawn(file, args(prefix ? prefix + command : command), {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...(process.env as Record<string, string>),
      ...(prefix && cwdFile ? { [CWD_FILE_ENV]: cwdFile } : {}),
    },
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
