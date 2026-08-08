// Shared executable lookup for daemon-owned child processes. npm/npx prepend
// project-local `node_modules/.bin` directories to PATH, which is useful for
// build tools but must not silently decide which host program Mirafold runs.

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type TrustedExecutableOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The directory whose repository must not supply the executable. */
  launchDir?: string;
  /** Known directories to search before (or instead of) PATH. */
  directories?: readonly string[];
  /** Agent CLIs retain filtered terminal lookup; OS chrome sets this false. */
  includePath?: boolean;
};

const NPM_BIN_SEGMENT = /(^|[\\/])node_modules[\\/]\.bin([\\/]|$)/i;

function canonical(candidate: string): string {
  try {
    return realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** True when npm or the launch repository can control this path. Both the
 * lexical and canonical forms are checked so an outside symlink cannot point
 * back into the repository and bypass the boundary. */
export function isProjectExecutablePath(
  candidate: string,
  launchDir = process.cwd(),
): boolean {
  if (NPM_BIN_SEGMENT.test(candidate)) return true;
  const realCandidate = canonical(candidate);
  if (NPM_BIN_SEGMENT.test(realCandidate)) return true;
  return isWithin(canonical(launchDir), realCandidate);
}

function namesFor(
  file: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform !== "win32" || path.extname(file)) return [file];
  return [
    file,
    ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
      .map((ext) => file + ext.toLowerCase()),
  ];
}

function runnable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve an executable without accepting relative PATH entries, npm bins,
 * launch-repository files, or symlinks back into the launch repository.
 * Returned paths are canonical and absolute, closing later cwd reinterpretation. */
export function locateTrustedExecutable(
  file: string,
  opts: TrustedExecutableOptions = {},
): string | undefined {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const launchDir = opts.launchDir ?? process.cwd();

  if (path.isAbsolute(file)) {
    if (!runnable(file, platform) || isProjectExecutablePath(file, launchDir)) return undefined;
    return canonical(file);
  }
  // A slash-bearing relative command is explicitly cwd-dependent. Mirafold's
  // daemon-owned launches must either use an absolute file or a filtered name.
  if (file.includes("/") || file.includes("\\")) return undefined;

  const pathDirs = opts.includePath === false
    ? []
    : (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const dirs = [...(opts.directories ?? []), ...pathDirs];
  const seen = new Set<string>();
  for (const rawDir of dirs) {
    // Relative and empty PATH entries mean the current project directory.
    if (!path.isAbsolute(rawDir)) continue;
    const dir = canonical(rawDir);
    if (seen.has(dir) || isProjectExecutablePath(dir, launchDir)) continue;
    seen.add(dir);
    for (const name of namesFor(file, platform, env)) {
      const candidate = path.join(dir, name);
      if (!runnable(candidate, platform) || isProjectExecutablePath(candidate, launchDir)) continue;
      return canonical(candidate);
    }
  }
  return undefined;
}
