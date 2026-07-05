import type { Action } from "@protocol";
import { RenderBlock } from "./registry/RenderBlock";

// The dock renders the same entry objects the transcript holds, so a
// `render` update-in-place (same wire id) is reflected here for free —
// pinned components are live by construction.
export type PinnedItem = {
  renderId: string;
  component: string;
  props: Record<string, unknown>;
};

export function PinDock({
  items,
  onUnpin,
  onCollapse,
  onAction,
}: {
  items: PinnedItem[];
  onUnpin: (renderId: string) => void;
  onCollapse: () => void;
  onAction: (action: Action, sourceId: string) => void;
}) {
  return (
    <aside className="pin-dock">
      <div className="pin-dock-head">
        <span className="pin-dock-title">Pinned</span>
        <button className="dock-btn" onClick={onCollapse} title="Collapse dock">
          ⇥
        </button>
      </div>
      <div className="pin-dock-items">
        {items.map((item) => (
          <div key={item.renderId} className="pin-dock-item">
            <button
              className="pin-btn is-pinned"
              onClick={() => onUnpin(item.renderId)}
              title="Unpin — return to its place in the transcript"
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
        ))}
      </div>
    </aside>
  );
}
