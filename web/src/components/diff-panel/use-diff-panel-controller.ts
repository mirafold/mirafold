import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsChangeRepo, WireMsg } from "@protocol";
import type { VersionedReviewSelection } from "../../change-review";
import {
  changeItems,
  changeSetIncomplete,
  changesHeaderCount,
  changesStateMessage,
  chooseChange,
  type ChangeItem,
} from "../../changes";
import { createChangesRequests } from "../../changes-requests";
import {
  emptyReviewProgress,
  fileIsReviewed,
  invalidateReviewProgress,
  nextUnreviewedIndex,
  pruneReviewProgress,
  reviewedFileCount,
  setFileReviewed,
  type ReviewProgress,
} from "../../review-progress";
import type { ZoneMsg } from "../../session-bus";
import { useFileView } from "../folder-tree/use-file-view";

type ChangeSetReply = Extract<WireMsg, { type: "fs_change_set" }>;

type ChangeSetState = {
  repos: FsChangeRepo[];
  truncated: boolean;
  loaded: boolean;
  pending: boolean;
  error?: string;
};

const EMPTY_CHANGE_SET: ChangeSetState = {
  repos: [],
  truncated: false,
  loaded: false,
  pending: false,
};

const REVIEW_SHORTCUT_EXCLUSION =
  ".prompt-box, input, textarea, select, [contenteditable='true']";

export function useDiffPanelController({
  open,
  subscribe,
  requestChanges,
  requestRead,
  requestDiff,
  sessionKey,
}: {
  open: boolean;
  subscribe: (listener: (message: ZoneMsg) => void) => () => void;
  requestChanges: () => string;
  requestRead: (path: string) => string;
  requestDiff: (path: string) => string;
  sessionKey?: string;
}) {
  const [changeSet, setChangeSet] = useState<ChangeSetState>(EMPTY_CHANGE_SET);
  const [reviewSelection, setReviewSelection] = useState<VersionedReviewSelection>();
  const reviewSelectionRef = useRef(reviewSelection);
  reviewSelectionRef.current = reviewSelection;
  const [reviewNotice, setReviewNotice] = useState<string>();
  // Viewport-local by construction: this component state is never put on the
  // wire or in storage. Each marker names the exact diff revision the server
  // observed when this viewport's user marked it.
  const [reviewProgress, setReviewProgress] = useState<ReviewProgress>(emptyReviewProgress);
  const reviewProgressRef = useRef(reviewProgress);
  reviewProgressRef.current = reviewProgress;
  const commitReviewProgress = useCallback((next: ReviewProgress) => {
    reviewProgressRef.current = next;
    setReviewProgress(next);
  }, []);
  const clearReviewSelection = useCallback((notice?: string) => {
    reviewSelectionRef.current = undefined;
    setReviewSelection(undefined);
    setReviewNotice(notice);
  }, []);
  const file = useFileView({ subscribe, requestRead, requestDiff, scopeKey: sessionKey });
  const items = useMemo(() => changeItems(changeSet.repos), [changeSet.repos]);
  const itemsByPath = useMemo(
    () => new Map(items.map((item) => [item.path, item])),
    [items],
  );
  const selectedIndex = file.selected
    ? items.findIndex((item) => item.path === file.selected?.path)
    : -1;
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : undefined;

  // The subscription and the request object live for the mount; the props
  // and file-view callbacks they call are read through refs at call time.
  const selectedRef = useRef(file.selected);
  selectedRef.current = file.selected;
  const openFileRef = useRef(file.openFile);
  openFileRef.current = file.openFile;
  const resetFileRef = useRef(file.reset);
  resetFileRef.current = file.reset;
  const cancelFileRequestRef = useRef(file.cancelPending);
  cancelFileRequestRef.current = file.cancelPending;
  const requestChangesRef = useRef(requestChanges);
  requestChangesRef.current = requestChanges;
  // The request lifecycle — one change-set request in flight, coalesced
  // refreshes and file opens — is the pure object in changes-requests.ts.
  const [requests] = useState(() =>
    createChangesRequests({
      requestChanges: () => requestChangesRef.current(),
      openFile: (item) => openFileRef.current(item.path, item.status, "diff"),
    }),
  );

  const requestSetNow = useCallback(() => {
    if (requests.requestNow()) {
      setChangeSet((current) => ({ ...current, pending: true, error: undefined }));
    }
  }, [requests]);

  useEffect(
    () =>
      subscribe((message) => {
        if (message.type === "session_created") {
          // sessionKey deliberately survives an ordinary reconnect, but any
          // fs_* reply lost with the old socket never will. The attach reply
          // is the first safe point to abandon those ids and query the newly
          // attached session. Disk events while disconnected are unknowable,
          // so no prior reviewed marker remains a trustworthy claim.
          requests.reset();
          cancelFileRequestRef.current();
          setChangeSet((current) => ({ ...current, pending: false }));
          if (reviewProgressRef.current.size > 0) {
            commitReviewProgress(emptyReviewProgress());
            setReviewNotice(
              "Connection resumed; reviewed files are unreviewed until the workspace is refreshed.",
            );
          }
          requests.scheduleRefresh();
        } else if (message.type === "fs_change_set") {
          const reply = message as ChangeSetReply;
          if (!requests.acceptReply(reply.id)) return;

          if (reply.error) {
            setChangeSet((current) => ({
              ...current,
              loaded: true,
              pending: false,
              error: reply.error,
            }));
          } else {
            setChangeSet({
              repos: reply.repos,
              truncated: Boolean(reply.truncated),
              loaded: true,
              pending: false,
            });
            const next = chooseChange(changeItems(reply.repos), selectedRef.current?.path);
            if (next) requests.queueFile(next);
            else resetFileRef.current();
          }
          requests.afterReply();
        } else if (message.type === "fs_changed") {
          if (message.reason !== "status") {
            const invalidation = invalidateReviewProgress(reviewProgressRef.current, message);
            if (invalidation.invalidated.length > 0) {
              commitReviewProgress(invalidation.progress);
              setReviewNotice(
                invalidation.invalidated.length === 1
                  ? `${invalidation.invalidated[0]} changed and is unreviewed again.`
                  : `${invalidation.invalidated.length} reviewed files may have changed and are unreviewed again.`,
              );
            }
          }
          requests.scheduleRefresh();
        } else if (message.type === "turn_end" && !("replay" in message && message.replay)) {
          requests.scheduleRefresh();
        }
      }),
    [commitReviewProgress, requests, subscribe],
  );

  useEffect(() => {
    setChangeSet(EMPTY_CHANGE_SET);
    requests.reset();
    requests.setSession(sessionKey);
    commitReviewProgress(emptyReviewProgress());
  }, [commitReviewProgress, requests, sessionKey]);

  useEffect(() => {
    const next = pruneReviewProgress(reviewProgressRef.current, items);
    if (next.size === reviewProgressRef.current.size) return;
    commitReviewProgress(next);
  }, [commitReviewProgress, items]);

  useEffect(() => {
    const current = reviewSelectionRef.current;
    if (!current || current.path === file.selected?.path) return;
    clearReviewSelection(
      file.selected
        ? "Selection cleared because another file was opened."
        : "Selection cleared because that file is no longer in workspace changes.",
    );
  }, [clearReviewSelection, file.selected?.path]);

  useEffect(() => {
    if (file.view.kind !== "diff") return;
    const current = reviewSelectionRef.current;
    if (!current) return;
    const nextNotice =
      current.path !== file.view.path
        ? "Selection cleared because another file was opened."
        : current.before !== file.view.before || current.after !== file.view.after
          ? "Selection cleared because this file changed."
          : undefined;
    if (!nextNotice) return;
    clearReviewSelection(nextNotice);
  }, [clearReviewSelection, file.view]);

  useEffect(() => {
    clearReviewSelection();
  }, [clearReviewSelection, sessionKey]);

  useEffect(() => {
    requests.setOpen(open);
    if (!open || !sessionKey) {
      requests.clearScheduled();
      return;
    }
    requests.scheduleRefresh();
  }, [open, requests, sessionKey]);

  useEffect(() => () => requests.clearScheduled(), [requests]);

  const requestSet = useCallback(() => {
    // A manual refresh is the user's trust floor when a watcher hint may have
    // been missed (including HEAD changes above a subdirectory session).
    // Until every reviewed file is reloaded, retaining those claims would be
    // stronger than the evidence available to this viewport.
    if (reviewProgressRef.current.size > 0) {
      commitReviewProgress(emptyReviewProgress());
      setReviewNotice("Workspace refreshed; reviewed files must be verified again.");
    }
    requestSetNow();
  }, [commitReviewProgress, requestSetNow]);

  const select = useCallback((item: ChangeItem) => {
    // The first change opens automatically. Clicking its already-active row
    // while that request is loading must not send the identical fs_diff again
    // inside the daemon's throttle window and replace a good result with an
    // error. An errored view remains deliberately retryable by clicking it.
    if (file.selected?.path === item.path && file.view.kind !== "error") return;
    requests.queueFile(item);
  }, [file.selected?.path, file.view.kind, requests]);
  const move = (delta: number) => {
    const next = items[selectedIndex + delta];
    if (next) select(next);
  };
  const selectedRevision =
    (file.view.kind === "diff" || file.view.kind === "binary") &&
    file.view.path === selectedItem?.path
      ? file.view.revision
      : undefined;
  const selectedReviewed = Boolean(
    selectedItem && fileIsReviewed(reviewProgress, selectedItem.path, selectedRevision),
  );
  const reviewedCount = reviewedFileCount(reviewProgress, items);
  const nextUnreviewed = nextUnreviewedIndex(items, reviewProgress, selectedItem?.path);
  const toggleReviewed = useCallback(() => {
    if (!selectedItem || !selectedRevision) return;
    const reviewed = fileIsReviewed(reviewProgressRef.current, selectedItem.path, selectedRevision);
    const next = setFileReviewed(
      reviewProgressRef.current,
      selectedItem.path,
      selectedRevision,
      !reviewed,
    );
    commitReviewProgress(next);
    setReviewNotice(
      reviewed
        ? `${selectedItem.path} is unreviewed again.`
        : `${selectedItem.path} marked reviewed for this revision.`,
    );
  }, [commitReviewProgress, selectedItem, selectedRevision]);
  const goToNextUnreviewed = useCallback(() => {
    const index = nextUnreviewedIndex(items, reviewProgressRef.current, selectedItem?.path);
    if (index < 0) return;
    select(items[index]);
  }, [items, select, selectedItem?.path]);

  useEffect(() => {
    if (file.view.kind !== "diff" && file.view.kind !== "binary") return;
    const markedRevision = reviewProgressRef.current.get(file.view.path);
    if (!markedRevision || markedRevision === file.view.revision) return;
    const next = setFileReviewed(
      reviewProgressRef.current,
      file.view.path,
      markedRevision,
      false,
    );
    commitReviewProgress(next);
    setReviewNotice(
      file.view.revision
        ? `${file.view.path} changed and is unreviewed again.`
        : `${file.view.path} can no longer be verified and is unreviewed again.`,
    );
  }, [commitReviewProgress, file.view]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(REVIEW_SHORTCUT_EXCLUSION)) return;
      if (event.key.toLowerCase() === "r") {
        if (!selectedRevision) return;
        event.preventDefault();
        toggleReviewed();
      } else if (event.key.toLowerCase() === "n") {
        const index = nextUnreviewedIndex(items, reviewProgressRef.current, selectedRef.current?.path);
        if (index < 0) return;
        event.preventDefault();
        select(items[index]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, open, select, selectedRevision, toggleReviewed]);

  const incomplete = changeSetIncomplete(changeSet.repos, changeSet.truncated);
  const hasRepoError = changeSet.repos.some((repo) => Boolean(repo.error));
  const headerCount = changesHeaderCount(changeSet.repos, changeSet.truncated, changeSet.error);
  const stateMessage = changesStateMessage({
    loaded: changeSet.loaded,
    repoCount: changeSet.repos.length,
    error: changeSet.error,
    itemCount: items.length,
    hasRepoError,
    incomplete,
  });

  return {
    changeSet,
    items,
    itemsByPath,
    file,
    selectedIndex,
    selectedItem,
    reviewSelection,
    setReviewSelection,
    reviewNotice,
    setReviewNotice,
    reviewProgress,
    requestSet,
    select,
    move,
    selectedRevision,
    selectedReviewed,
    reviewedCount,
    nextUnreviewed,
    toggleReviewed,
    goToNextUnreviewed,
    incomplete,
    headerCount,
    stateMessage,
  };
}
