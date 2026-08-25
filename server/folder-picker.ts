// Host-native working-directory picker: the browser cannot turn a
// FileSystemDirectoryHandle into the absolute path an agent process needs as
// cwd, so an explicit onboarding click asks the LOCAL daemon to open the
// operating system's own directory dialog. No shell is involved: every path
// is an argv/env value, never executable text.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { locateTrustedExecutable } from "./security/executable-trust";

const PICKER_TITLE = "Choose a Mirafold working directory";
const PICKER_OUTPUT_MAX_BYTES = 16_384;
const PICKER_TERMINATE_GRACE_MS = 250;
const LINUX_SYSTEM_BIN_DIRS = [
  "/usr/bin",
  "/bin",
  "/run/current-system/sw/bin",
  "/usr/local/bin",
  "/snap/bin",
] as const;
const LINUX_DIALOG_STARTUP_ERROR =
  /failed to open display|cannot open display|could not connect to display|could not load the qt platform plugin|no qt platform plugin/i;

// Native dialogs need the signed-in desktop session, locale, and temporary
// directory — not the daemon's model-provider keys, relay credentials, or an
// arbitrary provider's custom env_key. An allowlist makes that true even for
// credential names Mirafold has never seen before. Loader/search-path overrides
// are absent; desktop backend/theme selectors remain for native fidelity.
const PICKER_ENV_KEYS = new Set([
  "PATHEXT",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_MONETARY",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "TMPDIR",
  "TMP",
  "TEMP",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_DIRS",
  "XDG_CONFIG_HOME",
  "DESKTOP_SESSION",
  "GDK_BACKEND",
  "GTK_THEME",
  "QT_QPA_PLATFORM",
  "QT_STYLE_OVERRIDE",
  "KDE_FULL_SESSION",
  "KDE_SESSION_VERSION",
  "__CF_USER_TEXT_ENCODING",
  "SYSTEMROOT",
  "WINDIR",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "SESSIONNAME",
  "MIRAFOLD_FOLDER_PICKER_START",
]);

function envValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const hit = Object.entries(source).find(([key]) => key.toUpperCase() === name);
  return hit?.[1];
}

function windowsRoot(env: NodeJS.ProcessEnv): string | undefined {
  const root = envValue(env, "SYSTEMROOT") ?? envValue(env, "WINDIR");
  return root && path.win32.isAbsolute(root) ? root : undefined;
}

function nativeHelperPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    const root = windowsRoot(env);
    return root
      ? [path.win32.join(root, "System32"), root].join(path.win32.delimiter)
      : "";
  }
  if (platform === "darwin") return "/usr/bin:/bin:/usr/sbin:/sbin";
  return LINUX_SYSTEM_BIN_DIRS.join(path.posix.delimiter);
}

const MAC_SCRIPT = [
  'set startFolder to POSIX file (system attribute "MIRAFOLD_FOLDER_PICKER_START")',
  `return POSIX path of (choose folder with prompt "${PICKER_TITLE}" default location startFolder)`,
].join("\n");

const WINDOWS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  `$dialog.Description = '${PICKER_TITLE}'`,
  "$dialog.SelectedPath = $env:MIRAFOLD_FOLDER_PICKER_START",
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
  "  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
  "  [Console]::Out.Write($dialog.SelectedPath)",
  "}",
].join("\n");

export type FolderPickerCommand = {
  file: string;
  args: string[];
  env?: Record<string, string>;
  /** Exit code/stderr shape produced when the user presses Cancel. */
  canceled: (code: number | null, stderr: string) => boolean;
};

export type FolderPickerProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type RunFolderPickerCommand = (
  command: FolderPickerCommand,
  signal?: AbortSignal,
) => Promise<FolderPickerProcessResult>;

type LocateExecutable = (
  file: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) => string | undefined;

function macFolderPickerCommand(startDir: string): FolderPickerCommand {
  return {
    file: "/usr/bin/osascript",
    args: ["-e", MAC_SCRIPT],
    env: { MIRAFOLD_FOLDER_PICKER_START: startDir },
    // AppleScript's `choose folder` reports user cancellation as -128.
    canceled: (code, stderr) => code === 1 && /user canceled|-128/i.test(stderr),
  };
}

function windowsFolderPickerCommand(
  startDir: string,
  env: NodeJS.ProcessEnv,
): FolderPickerCommand | undefined {
  const root = windowsRoot(env);
  if (!root) return undefined;
  const systemPowerShell = path.win32.join(
    root,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return {
    file: systemPowerShell,
    args: ["-NoLogo", "-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT],
    env: { MIRAFOLD_FOLDER_PICKER_START: startDir },
    // FolderBrowserDialog writes nothing and exits successfully on Cancel.
    canceled: () => false,
  };
}

function linuxFolderPickerCommands(startDir: string): FolderPickerCommand[] {
  const initial = startDir.endsWith(path.sep) ? startDir : startDir + path.sep;
  const canceled = (code: number | null, stderr: string) =>
    code === 1 && !LINUX_DIALOG_STARTUP_ERROR.test(stderr);
  return [
    {
      file: "zenity",
      args: [
        "--file-selection",
        "--directory",
        `--title=${PICKER_TITLE}`,
        `--filename=${initial}`,
      ],
      canceled,
    },
    {
      file: "kdialog",
      args: ["--title", PICKER_TITLE, "--getexistingdirectory", startDir],
      canceled,
    },
  ];
}

/** Platform recipes, exported so Tier 1 pins the native contract without
 *  opening a real GUI. Linux tries the two desktop-standard helpers in order. */
export function folderPickerCommands(
  startDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): FolderPickerCommand[] {
  switch (platform) {
    case "darwin":
      return [macFolderPickerCommand(startDir)];
    case "win32": {
      const command = windowsFolderPickerCommand(startDir, env);
      return command ? [command] : [];
    }
    case "linux":
      return linuxFolderPickerCommands(startDir);
    default:
      return [];
  }
}

/** Resolve only operating-system helper locations. Ambient PATH is deliberately
 * ignored: npm/npx put project executables there, and Browse must never run one. */
export function locateExecutable(
  file: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return locateTrustedExecutable(file, {
    platform,
    env,
    directories: platform === "linux" ? LINUX_SYSTEM_BIN_DIRS : [],
    includePath: false,
  });
}

export function folderPickerAvailable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  locate: LocateExecutable = locateExecutable,
): boolean {
  if (platform === "linux" && !env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim()) {
    return false;
  }
  return folderPickerCommands(process.cwd(), platform, env).some((c) =>
    Boolean(locate(c.file, platform, env)),
  );
}

/** Build the deliberately narrow environment inherited by the native helper.
 * Matching case-insensitively also preserves Windows' environment semantics. */
export function folderPickerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  additions: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...source, ...additions })) {
    if (value !== undefined && PICKER_ENV_KEYS.has(key.toUpperCase())) safe[key] = value;
  }
  safe.PATH = nativeHelperPath(platform, source);
  return safe;
}

function abortError(): Error {
  const err = new Error("folder picker aborted");
  err.name = "AbortError";
  return err;
}

/** Spawn one native dialog with bounded output and no shell. */
export function runFolderPickerCommand(
  command: FolderPickerCommand,
  signal?: AbortSignal,
): Promise<FolderPickerProcessResult> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      env: folderPickerEnvironment(process.env, command.env),
      // The selected start directory is already an argv/env value. Keeping the
      // native program out of an untrusted repository also prevents accidental
      // project-local config/module discovery inside otherwise trusted helpers.
      cwd: os.homedir(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let pendingError: Error | undefined;
    let closing = false;
    let closed = false;
    let hardKill: NodeJS.Timeout | undefined;

    const signalChild = (killSignal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, killSignal);
          return;
        } catch {
          // The child can be signaled before its new process group is visible.
        }
      }
      child.kill(killSignal);
    };

    const requestStop = (err: Error) => {
      pendingError ??= err;
      if (closing || closed) return;
      closing = true;
      try {
        signalChild("SIGTERM");
      } catch {
        // A natural exit may have won the race; close still settles truthfully.
      }
      hardKill = setTimeout(() => {
        if (closed) return;
        try {
          signalChild("SIGKILL");
        } catch {
          // As above, close is authoritative; ESRCH means it is already coming.
        }
      }, PICKER_TERMINATE_GRACE_MS);
      hardKill.unref();
    };

    const onAbort = () => requestStop(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    // The signal can flip between the pre-spawn guard and listener attachment.
    if (signal?.aborted) onAbort();

    const capture = (which: "stdout" | "stderr", chunk: Buffer) => {
      if (closing) return;
      const next = Buffer.concat([which === "stdout" ? stdout : stderr, chunk]);
      if (next.byteLength > PICKER_OUTPUT_MAX_BYTES) {
        requestStop(new Error("The system folder picker returned too much output."));
        return;
      }
      if (which === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", (err) => {
      // Spawn failures have no live child to terminate, but Node still follows
      // with close; waiting for it keeps one authoritative settlement path.
      pendingError ??= err;
    });
    child.once("close", (code) => {
      closed = true;
      if (hardKill) clearTimeout(hardKill);
      signal?.removeEventListener("abort", onAbort);
      if (pendingError) {
        reject(pendingError);
        return;
      }
      resolve({
        code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Start the dialog somewhere useful. A half-typed/nonexistent path is the
 *  reason the picker may have been opened, so it falls back instead of erroring. */
export function folderPickerStartDir(
  requested: string | undefined,
  fallback = process.cwd(),
  home = os.homedir(),
  directoryExists: (candidate: string) => boolean = isDirectory,
): string {
  const raw = requested?.trim();
  if (!raw) return fallback;
  const expanded = raw.replace(/^~(?=[/\\]|$)/, home);
  const candidate = path.resolve(expanded);
  return directoryExists(candidate) ? candidate : fallback;
}

export type PickHostDirectory = (
  requestedStart?: string,
  signal?: AbortSignal,
) => Promise<string | undefined>;

type FolderPickerOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  locate?: LocateExecutable;
  run?: RunFolderPickerCommand;
  fallbackDir?: () => string;
  homeDir?: () => string;
  directoryExists?: (candidate: string) => boolean;
};

function resolveSelectedDirectory(
  output: string,
  directoryExists: (candidate: string) => boolean,
): string | undefined {
  // Windows cancellation is a successful process with empty stdout; all
  // three platform tools append at most one line ending on success.
  const selected = output.replace(/\r?\n$/, "");
  if (!selected) return undefined;
  const absolute = path.resolve(selected);
  if (!directoryExists(absolute)) {
    throw new Error("The system folder picker returned a path that is not a directory.");
  }
  return absolute;
}

/** One shared service instance means two tabs cannot stack native dialogs on
 *  the host. Dependencies are injectable so tests never open a real GUI. */
export function createFolderPicker(opts: FolderPickerOptions = {}): PickHostDirectory {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const findExecutable = opts.locate ?? locateExecutable;
  const runCommand = opts.run ?? runFolderPickerCommand;
  const fallbackDir = opts.fallbackDir ?? (() => process.cwd());
  const homeDir = opts.homeDir ?? os.homedir;
  const directoryExists = opts.directoryExists ?? isDirectory;
  let active = false;

  return async (requestedStart, signal) => {
    if (signal?.aborted) throw abortError();
    if (active) throw new Error("A folder picker is already open on this computer.");
    active = true;
    try {
      const startDir = folderPickerStartDir(
        requestedStart,
        fallbackDir(),
        homeDir(),
        directoryExists,
      );
      const commands = folderPickerCommands(startDir, platform, env);
      let lastFailure: Error | undefined;
      for (const recipe of commands) {
        const executable = findExecutable(recipe.file, platform, env);
        if (!executable) continue;
        const command = { ...recipe, file: executable };
        let result: FolderPickerProcessResult;
        try {
          result = await runCommand(command, signal);
        } catch (err) {
          if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
          lastFailure = err instanceof Error ? err : new Error(String(err));
          // On Linux, a present helper can still be unusable under the active
          // desktop; try the other toolkit before surfacing the failure.
          if (platform === "linux") continue;
          throw lastFailure;
        }
        if (recipe.canceled(result.code, result.stderr)) return undefined;
        if (result.code !== 0) {
          lastFailure = new Error("The system folder picker could not open.");
          if (platform === "linux") continue;
          throw lastFailure;
        }
        return resolveSelectedDirectory(result.stdout, directoryExists);
      }
      if (lastFailure) throw lastFailure;
      throw new Error(
        platform === "linux"
          ? "No graphical folder picker is available. Install Zenity or KDialog, or type the path."
          : "No graphical folder picker is available. Type the path instead.",
      );
    } finally {
      active = false;
    }
  };
}

export const pickHostDirectory = createFolderPicker();
