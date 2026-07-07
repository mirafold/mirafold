/** Render a path the way a terminal prompt would: the home prefix becomes ~. */
export function tildify(p: string | undefined, home: string | undefined): string | undefined {
  return p && home && (p === home || p.startsWith(home + "/"))
    ? "~" + p.slice(home.length)
    : p;
}
