// Browser opening is host chrome, not project code. Keep every executable in
// this chain on an operating-system path and pass only desktop-session state.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LINUX_OPENERS = [
  "/usr/bin/xdg-open",
  "/bin/xdg-open",
  "/run/current-system/sw/bin/xdg-open",
  "/usr/local/bin/xdg-open",
];
const LINUX_SYSTEM_PATH = [
  "/usr/bin",
  "/bin",
  "/run/current-system/sw/bin",
  "/usr/local/bin",
  "/usr/sbin",
  "/sbin",
  "/snap/bin",
].join(":");
const MAC_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const DESKTOP_ENV_KEYS = new Set([
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
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
]);

function envValue(source, name) {
  return Object.entries(source).find(([key]) => key.toUpperCase() === name)?.[1];
}

function windowsRoot(env) {
  const root = envValue(env, "SYSTEMROOT") ?? envValue(env, "WINDIR");
  return root && path.win32.isAbsolute(root) ? root : undefined;
}

function runnable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve only fixed operating-system opener locations. PATH is not an input. */
export function browserOpenCommand(
  url,
  platform = process.platform,
  env = process.env,
  canRun = runnable,
) {
  if (platform === "darwin") {
    return canRun("/usr/bin/open") ? { file: "/usr/bin/open", args: [url] } : undefined;
  }
  if (platform === "win32") {
    const root = windowsRoot(env);
    if (!root) return undefined;
    const file = path.win32.join(root, "explorer.exe");
    return canRun(file) ? { file, args: [url] } : undefined;
  }
  if (platform === "linux") {
    const file = LINUX_OPENERS.find(canRun);
    return file ? { file, args: [url] } : undefined;
  }
  return undefined;
}

/** Credentials, provider settings, BROWSER command overrides, and loader hooks
 * have no business crossing into an opener or the browser it launches. */
export function browserOpenEnvironment(
  source = process.env,
  platform = process.platform,
) {
  const safe = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (value !== undefined && (DESKTOP_ENV_KEYS.has(upper) || upper.startsWith("LC_"))) {
      safe[key] = value;
    }
  }
  if (platform === "win32") {
    const root = windowsRoot(source);
    safe.PATH = root
      ? [path.win32.join(root, "System32"), root].join(path.win32.delimiter)
      : "";
  } else {
    safe.PATH = platform === "darwin" ? MAC_SYSTEM_PATH : LINUX_SYSTEM_PATH;
  }
  return safe;
}

/** Best-effort and intentionally injectable only as a direct function argument
 * for tests; the production launcher never reads an opener path from env. */
export function openBrowser(url, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const sourceEnv = opts.env ?? process.env;
  const command = opts.command ?? browserOpenCommand(url, platform, sourceEnv);
  if (!command) return undefined;
  const child = spawn(command.file, command.args, {
    cwd: os.homedir(),
    env: browserOpenEnvironment(sourceEnv, platform),
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.once("error", () => {});
  child.unref();
  return child;
}
