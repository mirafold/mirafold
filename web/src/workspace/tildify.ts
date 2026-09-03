/** Render a path the way a terminal prompt would: the home prefix becomes ~. */
export function tildify(p: string | undefined, home: string | undefined): string | undefined {
  if (!p || !home) return p;
  const windowsStyle = [p, home].some(
    (value) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"),
  );
  const comparablePath = windowsStyle ? p.replaceAll("\\", "/").toLowerCase() : p;
  const comparableHome = windowsStyle ? home.replaceAll("\\", "/").toLowerCase() : home;
  if (!comparablePath.startsWith(comparableHome)) return p;
  const suffix = p.slice(home.length);
  return suffix === "" || suffix.startsWith("/") || suffix.startsWith("\\")
    ? `~${suffix}`
    : p;
}
