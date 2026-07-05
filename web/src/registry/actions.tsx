import { createContext, useContext } from "react";
import type { Action } from "@protocol";

/**
 * How a registry component emits an action (Phase 2). The provider is set
 * per rendered block by RenderBlock, binding the block's render id as the
 * action's sourceId — components never see the socket, they ask the shell.
 */
export const ActionContext = createContext<(action: Action) => void>(() => {});

export const useAction = () => useContext(ActionContext);

/** Shared button row for components whose props carry `actions`. */
export function ActionRow({
  actions,
}: {
  actions?: { label: string; action: Action }[];
}) {
  const emit = useAction();
  if (!actions || actions.length === 0) return null;
  return (
    <div className="rc-actions">
      {actions.map((a, i) => (
        <button key={i} className="rc-action-btn" onClick={() => emit(a.action)}>
          {a.label}
        </button>
      ))}
    </div>
  );
}
