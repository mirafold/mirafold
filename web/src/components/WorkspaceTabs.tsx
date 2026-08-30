export type WorkspaceSurface = "folder-tree" | "diff-panel";

const SURFACES: readonly (readonly [WorkspaceSurface, string])[] = [
  ["folder-tree", "Files"],
  ["diff-panel", "Changes"],
];

/** The phone drawer's view switch: on ≤640px Files and
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
      {SURFACES.map(([surface, label]) => (
        <button
          key={surface}
          type="button"
          className={"workspace-tab" + (active === surface ? " is-active" : "")}
          aria-pressed={active === surface}
          onClick={() => active !== surface && onSwitch(surface)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
