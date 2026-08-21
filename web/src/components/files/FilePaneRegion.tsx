import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ZoneMsg } from "../../session-bus";
import { useIsPhone } from "../../use-is-phone";
import { FileView } from "./FileView";
import {
  activateFilePane,
  closeFilePane,
  emptyFilePaneState,
  moveFilePane,
  openFilePane,
  type FilePaneMove,
  type FilePaneState,
  type FilePaneTab,
} from "./file-pane-state";
import { useFileView } from "./use-file-view";

export interface FilePaneRegionHandle {
  open(path: string, status: string | undefined, opener: HTMLElement): void;
}

type FilePaneRegionProps = {
  subscribe: (listener: (message: ZoneMsg) => void) => () => void;
  requestRead: (path: string) => string;
  requestDiff: (path: string) => string;
  sessionKey?: string;
};

type PendingFocus =
  | { kind: "tab"; id: number }
  | { kind: "return"; opener?: HTMLElement };

const tabId = (id: number) => `file-pane-tab-${id}`;
const panelId = (id: number) => `file-pane-panel-${id}`;
const basename = (path: string) => path.split("/").at(-1) || path;

/** The one desktop pane slot PN establishes for file viewers now and terminal
 * viewers later. Each tab mounts its own useFileView controller: replies stay
 * independently correlated even when several files are waiting at once. */
export const FilePaneRegion = forwardRef<FilePaneRegionHandle, FilePaneRegionProps>(
  function FilePaneRegion({ subscribe, requestRead, requestDiff, sessionKey }, ref) {
    const [state, setState] = useState<FilePaneState>(emptyFilePaneState);
    const stateRef = useRef(state);
    stateRef.current = state;
    const nextId = useRef(1);
    const openers = useRef(new Map<number, HTMLElement>());
    const pendingFocus = useRef<PendingFocus | null>(null);
    const [focusVersion, setFocusVersion] = useState(0);
    const phone = useIsPhone();

    const commit = useCallback((next: FilePaneState) => {
      stateRef.current = next;
      setState(next);
    }, []);

    const requestFocus = useCallback((target: PendingFocus) => {
      pendingFocus.current = target;
      setFocusVersion((version) => version + 1);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        open(path, status, opener) {
          const current = stateRef.current;
          const existing = current.tabs.find((tab) => tab.path === path);
          const id = existing?.id ?? nextId.current++;
          openers.current.set(id, opener);
          commit(openFilePane(current, path, status, id));
          requestFocus({ kind: "tab", id });
        },
      }),
      [commit, requestFocus],
    );

    const activate = useCallback(
      (id: number, focus = false) => {
        commit(activateFilePane(stateRef.current, id));
        if (focus) requestFocus({ kind: "tab", id });
      },
      [commit, requestFocus],
    );

    const close = useCallback(
      (id: number) => {
        const current = stateRef.current;
        const opener = openers.current.get(id);
        const next = closeFilePane(current, id);
        openers.current.delete(id);
        commit(next);
        if (next.activeId !== null) requestFocus({ kind: "tab", id: next.activeId });
        else requestFocus({ kind: "return", opener });
      },
      [commit, requestFocus],
    );

    const move = useCallback(
      (fromId: number, direction: FilePaneMove) => {
        const id = moveFilePane(stateRef.current, fromId, direction);
        if (id !== null) activate(id, true);
      },
      [activate],
    );

    useLayoutEffect(() => {
      const target = pendingFocus.current;
      if (!target) return;
      pendingFocus.current = null;
      if (target.kind === "tab") {
        document.getElementById(tabId(target.id))?.focus({ preventScroll: true });
        return;
      }
      const opener = target.opener;
      if (opener?.isConnected && opener.getClientRects().length > 0) {
        opener.focus({ preventScroll: true });
      } else {
        document.querySelector<HTMLButtonElement>(".ab-files:not(:disabled)")?.focus({
          preventScroll: true,
        });
      }
    }, [focusVersion, state]);

    useEffect(() => {
      const empty = emptyFilePaneState();
      stateRef.current = empty;
      setState(empty);
      openers.current.clear();
    }, [sessionKey]);

    if (phone || state.tabs.length === 0) return null;

    const activeTab = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];

    return (
      <aside className="file-pane-region" aria-label="Open file panes">
        <div className="file-pane-tabbar">
          <div className="file-pane-tabs" role="tablist" aria-label="Open files">
            {state.tabs.map((tab) => {
              const active = tab.id === state.activeId;
              return (
                <button
                  type="button"
                  className="file-pane-tab"
                  id={tabId(tab.id)}
                  key={tab.id}
                  role="tab"
                  aria-selected={active}
                  aria-controls={panelId(tab.id)}
                  aria-label={tab.path}
                  title={tab.path}
                  tabIndex={active ? 0 : -1}
                  onClick={() => activate(tab.id)}
                  onKeyDown={(event) => {
                    const direction: FilePaneMove | undefined =
                      event.key === "ArrowLeft"
                        ? "previous"
                        : event.key === "ArrowRight"
                          ? "next"
                          : event.key === "Home"
                            ? "first"
                            : event.key === "End"
                              ? "last"
                              : undefined;
                    if (!direction) return;
                    event.preventDefault();
                    move(tab.id, direction);
                  }}
                >
                  {basename(tab.path)}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="file-pane-close"
            aria-label={`Close ${activeTab.path}`}
            title="Close active file"
            onClick={() => close(activeTab.id)}
          >
            ×
          </button>
        </div>
        {state.tabs.map((tab) => (
          <FilePaneViewer
            key={tab.id}
            tab={tab}
            active={tab.id === state.activeId}
            subscribe={subscribe}
            requestRead={requestRead}
            requestDiff={requestDiff}
            sessionKey={sessionKey}
          />
        ))}
      </aside>
    );
  },
);

function FilePaneViewer({
  tab,
  active,
  subscribe,
  requestRead,
  requestDiff,
  sessionKey,
}: FilePaneRegionProps & { tab: FilePaneTab; active: boolean }) {
  const file = useFileView({ subscribe, requestRead, requestDiff, scopeKey: sessionKey });

  useEffect(() => {
    file.openFile(tab.path, tab.status, tab.status ? "diff" : "content");
  }, [tab.requestVersion]);

  const onMode = (mode: "content" | "diff") => file.openFile(tab.path, tab.status, mode);

  return (
    <section
      className="file-pane-panel"
      id={panelId(tab.id)}
      role="tabpanel"
      aria-labelledby={tabId(tab.id)}
      hidden={!active}
    >
      <div className="file-pane-path" title={tab.path}>
        <span>{tab.path}</span>
        {tab.status && (
          <span className="files-file-tabs" role="group" aria-label={`${tab.path} view`}>
            <button
              type="button"
              className={"files-tab" + (file.mode === "content" ? " is-active" : "")}
              aria-pressed={file.mode === "content"}
              onClick={() => onMode("content")}
            >
              file
            </button>
            <button
              type="button"
              className={"files-tab" + (file.mode === "diff" ? " is-active" : "")}
              aria-pressed={file.mode === "diff"}
              onClick={() => onMode("diff")}
            >
              diff
            </button>
          </span>
        )}
      </div>
      <div
        className="files-view file-pane-view"
        tabIndex={0}
        role="region"
        aria-label={`${tab.path} — ${file.mode === "diff" ? "diff" : "contents"}`}
      >
        <FileView state={file.view} />
      </div>
    </section>
  );
}
