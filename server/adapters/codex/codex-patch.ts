import { displayPath } from "../wire-helpers";

/** One file change on an apply_patch row, as the browser renders it. */
export type PatchChange = {
  path: string;
  kind: "add" | "delete" | "update";
  /** A unified diff for `update`; the whole file's content for `add`/`delete`. */
  diff: string;
  movePath?: string;
};

/**
 * app-server v2 delivers `fileChange.changes` as `[{ path, kind: { type,
 * move_path }, diff }]` — `kind` is an OBJECT (read from the wire 2026-08-30;
 * the earlier fixture guessed a string and every edit row was titled
 * "[object Object]" for a month). The persisted rollout form is a map keyed
 * by path with `unified_diff`/`content`; both are accepted so a fixture from
 * either source normalizes the same way. Paths inside the workspace are
 * shown relative to it, as the terminal prints them.
 */
export function normalizePatchChanges(raw: unknown, workspaceDir: string): PatchChange[] {
  const entries: { path: string; change: Record<string, unknown> }[] = [];
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (typeof c === "object" && c !== null && typeof (c as { path?: unknown }).path === "string") {
        entries.push({ path: (c as { path: string }).path, change: c as Record<string, unknown> });
      }
    }
  } else if (typeof raw === "object" && raw !== null) {
    for (const [path, c] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof c === "object" && c !== null) entries.push({ path, change: c as Record<string, unknown> });
    }
  }
  return entries.map(({ path, change }) => {
    const kindRaw = change.kind ?? change.type;
    const kindObj = typeof kindRaw === "object" && kindRaw !== null ? (kindRaw as Record<string, unknown>) : undefined;
    const kindName = String(kindObj ? kindObj.type : kindRaw ?? "update");
    const kind: PatchChange["kind"] = kindName === "add" || kindName === "delete" ? kindName : "update";
    const diffRaw = change.diff ?? change.unified_diff ?? change.content;
    const moveRaw = kindObj?.move_path ?? change.move_path;
    const out: PatchChange = {
      path: displayPath(path, workspaceDir),
      kind,
      diff: typeof diffRaw === "string" ? diffRaw : "",
    };
    if (typeof moveRaw === "string" && moveRaw) out.movePath = displayPath(moveRaw, workspaceDir);
    return out;
  });
}

/** "Updated server/x.ts", "Added NOTES.md", "Deleted a.md", "Moved a → b". */
export function describePatchChange(c: PatchChange): string {
  if (c.movePath) return `Moved ${c.path} → ${c.movePath}`;
  return `${c.kind === "add" ? "Added" : c.kind === "delete" ? "Deleted" : "Updated"} ${c.path}`;
}
