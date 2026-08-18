export type WorkspaceSurface = "files" | "changes";

/** The phone drawer's view switch (2026-08-18, Kyle): on ≤640px Files and
 * Changes share one full-screen drawer, opened by the status bar's single
 * workspace toggle, and this segmented control at the drawer's head is how
 * the user moves between them — in place of the two side-by-side status-bar
 * icons. Phone-only; the desktop rail keeps one icon per surface. A group of
 * pressed/unpressed buttons rather than a tablist: the two views are separate
 * panels, not tab panels of one composite widget. */
export function WorkspaceTabs({
  active,
  onSwitch,
}: {
  active: WorkspaceSurface;
  onSwitch: (surface: WorkspaceSurface) => void;
}) {
  return (
    <div className="workspace-tabs" role="group" aria-label="Workspace view">
      <button
        type="button"
        className={"workspace-tab" + (active === "files" ? " is-active" : "")}
        aria-pressed={active === "files"}
        onClick={() => active !== "files" && onSwitch("files")}
      >
        Files
      </button>
      <button
        type="button"
        className={"workspace-tab" + (active === "changes" ? " is-active" : "")}
        aria-pressed={active === "changes"}
        onClick={() => active !== "changes" && onSwitch("changes")}
      >
        Changes
      </button>
    </div>
  );
}
