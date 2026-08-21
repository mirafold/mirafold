export type FilePaneTab = {
  id: number;
  path: string;
  status?: string;
  requestVersion: number;
};

export type FilePaneState = {
  tabs: FilePaneTab[];
  activeId: number | null;
};

export const emptyFilePaneState = (): FilePaneState => ({ tabs: [], activeId: null });

/** Open paths are unique tabs. Reopening one activates and refreshes that
 * viewer instead of multiplying tabs for the same file. */
export function openFilePane(
  state: FilePaneState,
  path: string,
  status: string | undefined,
  nextId: number,
): FilePaneState {
  const existing = state.tabs.find((tab) => tab.path === path);
  if (existing) {
    return {
      tabs: state.tabs.map((tab) =>
        tab.id === existing.id
          ? { ...tab, status, requestVersion: tab.requestVersion + 1 }
          : tab,
      ),
      activeId: existing.id,
    };
  }
  return {
    tabs: [...state.tabs, { id: nextId, path, status, requestVersion: 0 }],
    activeId: nextId,
  };
}

export function activateFilePane(state: FilePaneState, id: number): FilePaneState {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state;
}

/** Closing the active tab selects its right neighbor, or the left neighbor
 * when it was last. Closing a background tab leaves the active tab alone. */
export function closeFilePane(state: FilePaneState, id: number): FilePaneState {
  const closedIndex = state.tabs.findIndex((tab) => tab.id === id);
  if (closedIndex < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  return {
    tabs,
    activeId: tabs[Math.min(closedIndex, tabs.length - 1)]?.id ?? null,
  };
}

export type FilePaneMove = "previous" | "next" | "first" | "last";

/** Roving-tab keyboard destination, wrapping only for the two arrow keys. */
export function moveFilePane(
  state: FilePaneState,
  fromId: number,
  move: FilePaneMove,
): number | null {
  if (state.tabs.length === 0) return null;
  if (move === "first") return state.tabs[0].id;
  if (move === "last") return state.tabs[state.tabs.length - 1].id;
  const index = state.tabs.findIndex((tab) => tab.id === fromId);
  if (index < 0) return state.activeId;
  const delta = move === "previous" ? -1 : 1;
  return state.tabs[(index + delta + state.tabs.length) % state.tabs.length].id;
}
