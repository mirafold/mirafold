import type { SessionMeta } from "@protocol";
import { sessionPath } from "../session-url";

// Each surface keeps its own class family (and stylesheet); the interaction
// contract below is the one thing they must never let drift.
const SURFACE = {
  fleet: { link: "fleet-link", edit: "fleet-edit", rename: "fleet-rename" },
  cockpit: { link: "cockpit-session-name", edit: "cockpit-edit", rename: "cockpit-rename" },
} as const;

/** A session row's name slot, shared by FleetView and the cockpit panel: the
 *  session link + rename pencil, or — mid-rename — the input (Enter/blur
 *  commits, Escape cancels). */
export function SessionName({
  s,
  surface,
  renaming,
  current,
  wrapClass,
  onStart,
  onCommit,
  onCancel,
}: {
  s: SessionMeta;
  surface: keyof typeof SURFACE;
  renaming: boolean;
  /** The session being viewed (cockpit): the link carries aria-current. */
  current?: boolean;
  /** Optional surface-specific wrapper around the link and pencil. */
  wrapClass?: string;
  onStart: () => void;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const cls = SURFACE[surface];
  if (renaming) {
    return (
      <input
        className={cls.rename}
        defaultValue={s.name}
        autoFocus
        spellCheck={false}
        aria-label={`New name for session ${s.name}`}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(e.currentTarget.value);
          else if (e.key === "Escape") onCancel();
        }}
      />
    );
  }
  const slot = (
    <>
      <a
        className={cls.link}
        href={sessionPath(s.sessionId)}
        title={surface === "cockpit" ? s.name : undefined}
        aria-current={current ? "page" : undefined}
      >
        {surface === "fleet" ? (
          <span className="fleet-link-label" title={s.name}>
            {s.name}
          </span>
        ) : (
          s.name
        )}
      </a>
      <button
        className={cls.edit}
        title="Rename this session"
        aria-label={`Rename session ${s.name}`}
        onClick={onStart}
      >
        ✎
      </button>
    </>
  );
  return wrapClass ? <span className={wrapClass}>{slot}</span> : slot;
}
