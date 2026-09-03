/**
 * Turn a Markdown href authored by an agent into the root-relative path the
 * shell's existing fs_read surface accepts. Absolute paths must stay inside
 * the session root; relative paths are rooted there. URL schemes and
 * traversal are never file links.
 *
 * Agent clients commonly suffix file links with `:line[:column]` or a hash
 * fragment. The Files presenter does not navigate to a line, but it can still
 * open the named file, so those location suffixes are removed here.
 */
export function workspacePathFromHref(
  href: string | undefined,
  workspaceRoot: string | undefined,
): string | null {
  if (!href || !workspaceRoot || href.length > 4_096) return null;
  // A query is meaningful to a web server, not to Mirafold's file reader.
  // An encoded `?` remains available to the rare POSIX filename containing it.
  if (href.includes("?")) return null;

  const hash = href.indexOf("#");
  const encodedPath = hash === -1 ? href : href.slice(0, hash);
  let candidate: string;
  try {
    candidate = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (!candidate || candidate.includes("\0")) return null;

  const windowsRoot = /^[A-Za-z]:[\\/]/.test(workspaceRoot);
  const posixRoot = workspaceRoot.startsWith("/");
  if (!windowsRoot && !posixRoot) return null;

  // A drive path is a filesystem path, not a URL scheme. Every other scheme
  // (http:, mailto:, javascript:, exp:, …) belongs to the normal URL gate.
  const windowsCandidate = /^\/?[A-Za-z]:[\\/]/.test(candidate);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate) && !windowsCandidate) return null;
  if (candidate.startsWith("//")) return null;

  // Codex-style clickable file targets carry locations after the filename.
  candidate = candidate.replace(/:\d+(?::\d+)?$/, "");
  if (!candidate) return null;

  const slash = (value: string) => value.replace(/\\/g, "/");
  const trimRoot = (value: string) => {
    const normalized = slash(value);
    return normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)
      ? normalized
      : normalized.replace(/\/+$/, "");
  };
  const root = trimRoot(workspaceRoot);
  let target = slash(candidate);
  if (windowsRoot && /^\/[A-Za-z]:\//.test(target)) target = target.slice(1);

  const targetAbsolute = target.startsWith("/") || /^[A-Za-z]:\//.test(target);
  let relative: string;
  if (targetAbsolute) {
    const comparableRoot = windowsRoot ? root.toLowerCase() : root;
    const comparableTarget = windowsRoot ? target.toLowerCase() : target;
    const prefix = comparableRoot.endsWith("/") ? comparableRoot : `${comparableRoot}/`;
    if (!comparableTarget.startsWith(prefix)) return null;
    relative = target.slice(prefix.length);
  } else {
    relative = target;
  }

  const segments = relative.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const clean = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  return clean && clean.length <= 4_096 ? clean : null;
}
