import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsChangeRepo, WireMsg } from "@protocol";
import type { ZoneMsg } from "../../session-bus";
import {
  changeCountLabel,
  changeItems,
  changeSetIncomplete,
  changeStatus,
  chooseChange,
  repoLabel,
  type ChangeItem,
} from "../../changes";
import { bellRefreshDelay } from "../../files-tree";
import { useEscapeKey } from "../../use-escape";
import { useFocusTrap } from "../../use-focus-trap";
import { useIsPhone } from "../../use-is-phone";
import { FileView } from "../files/FileView";
import { useFileView } from "../files/use-file-view";

type ChangeSetReply = Extract<WireMsg, { type: "fs_change_set" }>;

type ChangeSetState = {
  repos: FsChangeRepo[];
  truncated: boolean;
  loaded: boolean;
  pending: boolean;
  error?: string;
};

const EMPTY: ChangeSetState = {
  repos: [],
  truncated: false,
  loaded: false,
  pending: false,
};

// A disk bell can immediately follow the query that opening the surface sent.
// Keep the follow-up outside the daemon's min-interval/git-in-flight window,
// and collapse bursts onto one fresh snapshot.
const CHANGE_REFRESH_GAP_MS = 1_000;

export function ChangesPanel({
  open,
  subscribe,
  requestChanges,
  requestRead,
  requestDiff,
  onClose,
  rootLabel,
  sessionKey,
}: {
  open: boolean;
  subscribe: (listener: (message: ZoneMsg) => void) => () => void;
  requestChanges: () => string;
  requestRead: (path: string) => string;
  requestDiff: (path: string) => string;
  onClose: () => void;
  rootLabel?: string;
  sessionKey?: string;
}) {
  const [set, setSet] = useState<ChangeSetState>(EMPTY);
  const file = useFileView({ subscribe, requestRead, requestDiff, scopeKey: sessionKey });
  const items = useMemo(() => changeItems(set.repos), [set.repos]);
  const itemsByPath = useMemo(
    () => new Map(items.map((item) => [item.path, item])),
    [items],
  );
  const selectedIndex = file.selected
    ? items.findIndex((item) => item.path === file.selected?.path)
    : -1;
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : undefined;

  const openRef = useRef(open);
  openRef.current = open;
  const selectedRef = useRef(file.selected);
  selectedRef.current = file.selected;
  const openFileRef = useRef(file.openFile);
  openFileRef.current = file.openFile;
  const resetFileRef = useRef(file.reset);
  resetFileRef.current = file.reset;
  const requestId = useRef<string | null>(null);
  const pending = useRef(false);
  const lastRequestAt = useRef(0);
  const refreshQueued = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestSet = useCallback(() => {
    if (pending.current || !sessionKey) {
      if (pending.current) refreshQueued.current = true;
      return;
    }
    pending.current = true;
    lastRequestAt.current = Date.now();
    requestId.current = requestChanges();
    setSet((current) => ({ ...current, pending: true, error: undefined }));
  }, [requestChanges, sessionKey]);
  const requestSetRef = useRef(requestSet);
  requestSetRef.current = requestSet;

  const scheduleRefresh = useCallback(() => {
    if (!openRef.current) return;
    if (pending.current) {
      refreshQueued.current = true;
      return;
    }
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(
      () => {
        refreshTimer.current = null;
        if (openRef.current) requestSetRef.current();
      },
      bellRefreshDelay(Date.now(), lastRequestAt.current, CHANGE_REFRESH_GAP_MS),
    );
  }, []);
  const scheduleRefreshRef = useRef(scheduleRefresh);
  scheduleRefreshRef.current = scheduleRefresh;

  useEffect(
    () =>
      subscribe((message) => {
        if (message.type === "fs_change_set") {
          const reply = message as ChangeSetReply;
          if (requestId.current !== reply.id) return;
          requestId.current = null;
          pending.current = false;

          if (reply.error) {
            setSet((current) => ({
              ...current,
              loaded: true,
              pending: false,
              error: reply.error,
            }));
          } else {
            setSet({
              repos: reply.repos,
              truncated: Boolean(reply.truncated),
              loaded: true,
              pending: false,
            });
            const next = chooseChange(changeItems(reply.repos), selectedRef.current?.path);
            if (next && openRef.current) {
              openFileRef.current(next.path, next.status, "diff");
            } else if (!next) {
              resetFileRef.current();
            }
          }

          if (refreshQueued.current) {
            refreshQueued.current = false;
            scheduleRefreshRef.current();
          }
        } else if (
          openRef.current &&
          (message.type === "fs_changed" ||
            (message.type === "turn_end" && !("replay" in message && message.replay)))
        ) {
          scheduleRefreshRef.current();
        }
      }),
    [subscribe],
  );

  useEffect(() => {
    setSet(EMPTY);
    requestId.current = null;
    pending.current = false;
    refreshQueued.current = false;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
  }, [sessionKey]);

  useEffect(() => {
    if (!open || !sessionKey) {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      refreshQueued.current = false;
      return;
    }
    scheduleRefreshRef.current();
  }, [open, sessionKey]);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const phone = useIsPhone();
  const panelRef = useRef<HTMLElement>(null);
  const modal = phone && open;
  useFocusTrap(panelRef, modal);
  useEscapeKey(modal ? onClose : undefined, { exclusive: true });

  if (!open) return null;

  const select = (item: ChangeItem) => {
    // The first change opens automatically. Clicking its already-active row
    // while that request is loading must not send the identical fs_diff again
    // inside the daemon's throttle window and replace a good result with an
    // error. An errored view remains deliberately retryable by clicking it.
    if (file.selected?.path === item.path && file.view.kind !== "error") return;
    file.openFile(item.path, item.status, "diff");
  };
  const move = (delta: number) => {
    const next = items[selectedIndex + delta];
    if (next) select(next);
  };
  const incomplete = changeSetIncomplete(set.repos, set.truncated);
  const hasRepoError = set.repos.some((repo) => Boolean(repo.error));
  const count = changeCountLabel(set.repos, set.truncated);
  const headerCount =
    set.error && set.repos.length === 0
      ? "unavailable"
      : set.repos.length === 0
        ? "no repository"
        : count;

  let stateMessage: { title: string; detail: string } | undefined;
  if (!set.loaded) {
    stateMessage = {
      title: "Loading workspace changes…",
      detail: "Comparing the working tree with Git HEAD.",
    };
  } else if (set.repos.length === 0 && !set.error) {
    stateMessage = {
      title: "No Git repositories found",
      detail: "This workspace is not inside a Git repository and contains no discoverable repositories.",
    };
  } else if (items.length === 0 && !hasRepoError && !set.error) {
    stateMessage = {
      title: "Working tree is clean",
      detail: "No files differ from Git HEAD in this workspace.",
    };
  } else if (items.length === 0 && (hasRepoError || set.error)) {
    stateMessage = {
      title: "Changes could not be loaded",
      detail: set.error ?? "Git could not inspect one or more repositories safely.",
    };
  }

  return (
    <aside
      className="changes-panel"
      aria-label="Workspace changes"
      ref={panelRef}
      role={phone ? "dialog" : undefined}
      aria-modal={phone ? true : undefined}
      tabIndex={phone ? -1 : undefined}
    >
      <header className="changes-head">
        {phone && (
          <button className="changes-icon-btn changes-close" onClick={onClose} aria-label="Back to conversation">
            ‹
          </button>
        )}
        <div className="changes-title-block">
          <h2>Workspace changes</h2>
          <span className="changes-subtitle">Working tree versus Git HEAD</span>
        </div>
        {set.loaded && <span className="changes-count">{headerCount}</span>}
        <button
          className="changes-icon-btn changes-refresh"
          onClick={requestSet}
          disabled={set.pending}
          title="Refresh workspace changes"
          aria-label="Refresh workspace changes"
        >
          <RefreshIcon />
        </button>
        {!phone && (
          <button className="changes-icon-btn changes-close" onClick={onClose} title="Close" aria-label="Close workspace changes">
            ×
          </button>
        )}
      </header>

      {set.error && items.length > 0 && (
        <div className="changes-warning" role="status">
          Refresh failed: {set.error}. Showing the last complete result.
        </div>
      )}
      {incomplete && items.length > 0 && (
        <div className="changes-warning" role="status">
          This list is incomplete; only the visible changes can be reviewed here.
        </div>
      )}

      <div className="changes-body">
        {!phone && items.length > 0 && (
          <nav className="changes-rail" aria-label="Changed files">
            {set.repos.map((repo) => (
              <section className="changes-repo" key={repo.root || "."}>
                <h3 title={repo.root || rootLabel}>{repoLabel(repo.root, rootLabel)}</h3>
                {repo.error && <div className="changes-repo-note changes-repo-error">{repo.error}</div>}
                {repo.entries.map((entry) => {
                  const item = itemsByPath.get(entry.path);
                  if (!item) return null;
                  const status = changeStatus(entry.status);
                  return (
                    <button
                      key={entry.path}
                      className={"changes-file" + (file.selected?.path === entry.path ? " is-active" : "")}
                      onClick={() => select(item)}
                      title={entry.path}
                      aria-current={file.selected?.path === entry.path ? "true" : undefined}
                    >
                      <span className={`changes-status changes-status-${status.code}`} aria-label={status.label} title={status.label}>
                        {status.code}
                      </span>
                      <span className="changes-file-name">{item.displayPath}</span>
                    </button>
                  );
                })}
                {repo.truncated && <div className="changes-repo-note">More changed files were omitted.</div>}
              </section>
            ))}
          </nav>
        )}

        <section className="changes-review" aria-label="Change review">
          {stateMessage ? (
            <div className="changes-state">
              <strong>{stateMessage.title}</strong>
              <span>{stateMessage.detail}</span>
            </div>
          ) : selectedItem ? (
            <>
              <div className="changes-file-head">
                {phone && (
                  <button
                    className="changes-nav-btn"
                    onClick={() => move(-1)}
                    disabled={selectedIndex <= 0}
                    aria-label="Previous changed file"
                    title="Previous changed file"
                  >
                    ‹
                  </button>
                )}
                <div className="changes-current-file">
                  <span className="changes-current-path" title={selectedItem.path}>{selectedItem.path}</span>
                  <span className={`changes-current-status changes-status-${changeStatus(selectedItem.status).code}`}>
                    {changeStatus(selectedItem.status).label}
                  </span>
                </div>
                <span className="changes-position" aria-label={`Change ${selectedIndex + 1} of ${items.length}`}>
                  {selectedIndex + 1} / {items.length}
                </span>
                {phone && (
                  <button
                    className="changes-nav-btn"
                    onClick={() => move(1)}
                    disabled={selectedIndex >= items.length - 1}
                    aria-label="Next changed file"
                    title="Next changed file"
                  >
                    ›
                  </button>
                )}
              </div>
              <div
                className="changes-view"
                tabIndex={0}
                role="region"
                aria-label={`${selectedItem.path} — diff`}
              >
                <FileView state={file.view} />
              </div>
            </>
          ) : null}
        </section>
      </div>
    </aside>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M13.4 7A5.5 5.5 0 1 0 13 10.2" />
      <path d="M10.1 3.8h3.3V.5" />
    </svg>
  );
}
