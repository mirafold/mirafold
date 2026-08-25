import type { Action } from "@protocol";
import { RenderBlock } from "../registry/RenderBlock";
import { Artifact } from "./Artifact";

// The dock renders the same entry objects the transcript holds, so a
// `render`/`artifact` update-in-place (same wire id) is reflected here for
// free — pinned blocks are live by construction.
type PinnedItem =
  | { kind: "render"; renderId: string; component: string; props: Record<string, unknown> }
  | { kind: "artifact"; artifactId: string; html: string; title?: string };

export function PinDock({
  items,
  onUnpin,
  onCollapse,
  onAction,
}: {
  items: PinnedItem[];
  onUnpin: (id: string) => void;
  onCollapse: () => void;
  onAction: (action: Action, sourceId: string) => void;
}) {
  return (
    // A landmark needs a name to be worth navigating to.
    <aside className="pin-dock" aria-label="Pinned">
      <div className="pin-dock-head">
        <span className="pin-dock-title">Pinned</span>
        <button className="dock-btn" onClick={onCollapse} title="Collapse dock" aria-label="Collapse dock">
          ⇥
        </button>
      </div>
      <div className="pin-dock-items">
        {items.map((item) =>
          item.kind === "render" ? (
            <div key={item.renderId} className="pin-dock-item">
              <button
                className="pin-btn is-pinned"
                onClick={() => onUnpin(item.renderId)}
                title="Unpin — return to its place in the transcript"
                aria-label={`Unpin ${item.component}`}
              >
                ✕
              </button>
              <RenderBlock
                component={item.component}
                props={item.props}
                renderId={item.renderId}
                onAction={onAction}
              />
            </div>
          ) : (
            <div key={item.artifactId} className="pin-dock-item">
              {/* The unpin control rides the artifact's own shell-drawn
                  chrome, not the hover overlay — nothing floats over the
                  sandboxed frame. */}
              <Artifact
                html={item.html}
                title={item.title}
                onAction={(action) => onAction(action, item.artifactId)}
                pin={{ pinned: true, onToggle: () => onUnpin(item.artifactId) }}
              />
            </div>
          ),
        )}
      </div>
    </aside>
  );
}
