// Host-native working-directory picker (N2): the browser cannot turn a
// FileSystemDirectoryHandle into the absolute path an agent process needs as
// cwd, so an explicit onboarding click asks the LOCAL daemon to open the
// operating system's own directory dialog. No shell is involved: every path
// is an argv/env value, never executable text.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PICKER_TITLE = "Choose a Mirafold working directory";
const PICKER_OUTPUT_MAX_BYTES = 16_384;
const LINUX_DIALOG_STARTUP_ERROR =
  /failed to open display|cannot open display|could not connect to display|could not load the qt platform plugin|no qt platform plugin/i;

// Native dialogs need the signed-in desktop session, locale, and temporary
// directory — not the daemon's model-provider keys, relay credentials, or an
// arbitrary provider's custom env_key. An allowlist makes that true even for
// credential names Mirafold has never seen before. Loader/plugin overrides are
// deliberately absent too: these helpers should use their system defaults.
const PICKER_ENV_KEYS = new Set([
  "PATH",
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
  "COMSPEC",
  "PSMODULEPATH",
  "SESSIONNAME",
  "MIRAFOLD_FOLDER_PICKER_START",
]);

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

/** Platform recipes, exported so Tier 1 pins the native contract without
 *  opening a real GUI. Linux tries the two desktop-standard helpers in order. */
export function folderPickerCommands(
  startDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): FolderPickerCommand[] {
  const startEnv = { MIRAFOLD_FOLDER_PICKER_START: startDir };
  if (platform === "darwin") {
    return [
      {
        file: "/usr/bin/osascript",
        args: ["-e", MAC_SCRIPT],
        env: startEnv,
        // AppleScript's `choose folder` reports user cancellation as -128.
        canceled: (code, stderr) => code === 1 && /user canceled|-128/i.test(stderr),
      },
    ];
  }
  if (platform === "win32") {
    const systemPowerShell = env.SystemRoot
      ? path.join(
          env.SystemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        )
      : "powershell.exe";
    return [
      {
        file: systemPowerShell,
        args: ["-NoLogo", "-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT],
        env: startEnv,
        // FolderBrowserDialog writes nothing and exits successfully on Cancel.
        canceled: () => false,
      },
    ];
  }
  if (platform === "linux") {
    const initial = startDir.endsWith(path.sep) ? startDir : startDir + path.sep;
    return [
      {
        file: "zenity",
        args: [
          "--file-selection",
          "--directory",
          `--title=${PICKER_TITLE}`,
          `--filename=${initial}`,
        ],
        canceled: (code, stderr) => code === 1 && !LINUX_DIALOG_STARTUP_ERROR.test(stderr),
      },
      {
        file: "kdialog",
        args: ["--title", PICKER_TITLE, "--getexistingdirectory", startDir],
        canceled: (code, stderr) => code === 1 && !LINUX_DIALOG_STARTUP_ERROR.test(stderr),
      },
    ];
  }
  return [];
}

/** Resolve a command exactly as a spawn would, but return an absolute file so
 *  a later cwd change cannot reinterpret a relative PATH entry. */
export function locateExecutable(
  file: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const names =
    platform === "win32" && !path.extname(file)
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((ext) => file + ext.toLowerCase())
      : [file];
  const direct = path.isAbsolute(file) || file.includes("/") || file.includes("\\");
  const dirs = direct ? [""] : (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = direct ? name : path.resolve(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Missing, a directory, or not executable — normal lookup continues.
      }
    }
  }
  return undefined;
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
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...source, ...additions })) {
    if (value !== undefined && PICKER_ENV_KEYS.has(key.toUpperCase())) safe[key] = value;
  }
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
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (err: Error | null, result?: FolderPickerProcessResult) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result!);
    };
    const capture = (which: "stdout" | "stderr", chunk: Buffer) => {
      const next = Buffer.concat([which === "stdout" ? stdout : stderr, chunk]);
      if (next.byteLength > PICKER_OUTPUT_MAX_BYTES) {
        child.kill();
        finish(new Error("The system folder picker returned too much output."));
        return;
      }
      if (which === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", (err) => finish(err));
    child.once("close", (code) =>
      finish(null, {
        code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      }),
    );
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

/** One shared service instance means two tabs cannot stack native dialogs on
 *  the host. Dependencies are injectable so tests never open a real GUI. */
export function createFolderPicker(opts: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  locate?: LocateExecutable;
  run?: RunFolderPickerCommand;
  fallbackDir?: () => string;
  homeDir?: () => string;
  directoryExists?: (candidate: string) => boolean;
} = {}): PickHostDirectory {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const locate = opts.locate ?? locateExecutable;
  const run = opts.run ?? runFolderPickerCommand;
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
        const executable = locate(recipe.file, platform, env);
        if (!executable) continue;
        const command = { ...recipe, file: executable };
        let result: FolderPickerProcessResult;
        try {
          result = await run(command, signal);
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
        // Windows cancellation is a successful process with empty stdout;
        // all three platform tools append at most one line ending on success.
        const selected = result.stdout.replace(/\r?\n$/, "");
        if (!selected) return undefined;
        const absolute = path.resolve(selected);
        if (!directoryExists(absolute)) {
          throw new Error("The system folder picker returned a path that is not a directory.");
        }
        return absolute;
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
