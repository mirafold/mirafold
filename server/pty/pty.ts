// @lydell/node-pty over upstream node-pty (2026-07-23): identical API, but
// prebuilt binaries ship as platform optionalDependencies (the esbuild
// pattern) — no install script, so current npm's script-blocking can't
// break the install, and users need no compiler toolchain. Upstream's
// postinstall compile crashed the daemon at first boot on default npm.
import { spawn, type IPty } from "@lydell/node-pty";
import { shellEnv } from "../project-env";
import { existsSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";

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
// consumes the raw stream is Tier 2. CSI (parameter bytes are ECMA-48's full
// 0x30–0x3F, so colon-subparameter SGR like `38:5:196` and the `<=>?` private
// prefixes strip too), OSC and DCS (BEL- or ST-terminated), and single-char
// ESC sequences; then CRLF/lone-CR normalize to LF (a progress bar's redraws
// stack as lines — acceptable for Tier 1).
const ANSI_RE =
  /\x1b\[[0-9:;<=>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// A sequence PREFIX at end-of-chunk: PTY reads split at arbitrary byte
// boundaries, so a chunk can end mid-sequence — cleaned per-chunk, the raw ESC
// and the sequence's tail would both leak to viewports and the agent's
// injected context. Matches only tails that could still complete (a finished
// sequence never matches, so it strips normally).
const PARTIAL_TAIL_RE = /\x1b(?:\[[0-9:;<=>?]*[ -/]*|\][^\x07\x1b]*\x1b?|P[^\x07\x1b]*\x1b?)?$/;

/**
 * A stateful cleaner for one PTY stream: strips ANSI sequences across chunk
 * boundaries by holding an unterminated tail (a partial escape sequence, or a
 * lone trailing CR that may be half of a CRLF) until the next chunk completes
 * it. `flush()` drains the hold at stream end — an escape fragment that never
 * completed is dropped (it was control data), a held CR normalizes.
 */
export function createPtyCleaner(maxHold = 4096): {
  clean(data: string): string;
  flush(): string;
} {
  let hold = "";
  const strip = (s: string) => s.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return {
    clean(data: string): string {
      let s = hold + data;
      hold = "";
      const partial = PARTIAL_TAIL_RE.exec(s);
      if (partial && partial[0].length <= maxHold) {
        s = s.slice(0, partial.index);
        hold = partial[0];
      }
      // A pathological unterminated OSC/DCS past maxHold falls through and is
      // cleaned as-is — bounded leakage beats unbounded buffering.
      if (s.endsWith("\r")) {
        hold = "\r" + hold;
        s = s.slice(0, -1);
      }
      return strip(s);
    },
    flush(): string {
      const s = hold.replace(PARTIAL_TAIL_RE, "");
      hold = "";
      return strip(s);
    },
  };
}

/** One-shot form for whole strings (tests, single-chunk callers). */
export function cleanPtyOutput(data: string): string {
  const c = createPtyCleaner();
  return c.clean(data) + c.flush();
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

/** Whether the shell binary is reachable — absolute/relative paths directly,
 *  bare names (`SHELL=zsh` is legal) through a PATH walk (with PATHEXT on
 *  win32, mirroring what the OS exec would try). Exported for tests. */
export function shellFound(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (isAbsolute(file) || file.includes("/") || file.includes("\\")) return existsSync(file);
  const exts =
    platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && exts.some((ext) => existsSync(join(dir, file + ext)))) return true;
  }
  return false;
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
  // catchable failure mode instead of two (R.4f). Bare names walk PATH so a
  // `SHELL=zsh` typo gets the same clean throw as an absolute path.
  if (!shellFound(file)) {
    throw new Error(`shell not found: ${file}`);
  }
  const proc: IPty = spawn(file, args(prefix ? prefix + command : command), {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd,
    // Not process.env verbatim: keys the checkout's .env supplied stay out
    // of the shell (project-env.ts shellEnv) — a terminal wouldn't export
    // them, and `!` output is recorded.
    env: {
      ...shellEnv(),
      ...(prefix && cwdFile ? { [CWD_FILE_ENV]: cwdFile } : {}),
    },
  });
  let killedByUs = false;
  const cleaner = createPtyCleaner();
  proc.onData((d) => {
    const clean = cleaner.clean(d);
    if (clean) onData(clean);
  });
  // The explicit-stop path below records only a kill that the OS/library
  // accepted. A request that raced a natural exit must keep that real exit
  // code instead of being relabelled as "killed".
  proc.onExit(({ exitCode, signal }) => {
    const tail = cleaner.flush();
    if (tail) onData(tail);
    onExit(killedByUs || signal ? null : exitCode);
  });
  return {
    write(data: string) {
      proc.write(data);
    },
    kill() {
      if (killedByUs) return;
      try {
        if (process.platform === "win32") {
          // ConPTY's kill has no signal parameter and terminates the process
          // tree. Passing one throws, per node-pty's API contract.
          proc.kill();
        } else {
          // node-pty's default SIGHUP is catchable/ignorable. Stop means stop:
          // forkpty makes the shell its process-group leader, so SIGKILL the
          // whole foreground group rather than leaving command children alive.
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            // A click can beat the child's setsid/process-group setup. In
            // that narrow window the group does not exist yet, but the shell
            // pid does; killing it directly is both confirmed and sufficient
            // because it has not had time to create descendants.
            process.kill(proc.pid, "SIGKILL");
          }
        }
        killedByUs = true;
      } catch {
        // Most commonly ESRCH: the command exited between the user's click
        // and this call. Leave killedByUs false so onExit reports the real
        // result. Unexpected kill failures likewise must not crash the daemon
        // or manufacture a successful Stop.
      }
    },
  };
}
