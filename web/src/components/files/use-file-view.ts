import { useCallback, useEffect, useRef, useState } from "react";
import type { ZoneMsg } from "../../session-bus";
import { diffToState, fileToState, type FileViewState } from "./FileView";

type FileViewMode = "content" | "diff";
type FileSelection = { path: string; status?: string };

const FILE_RETRY_DELAY_MS = 275;
const FILE_RETRY_LIMIT = 4;

/** The daemon answers throttled/busy requests instead of dropping them. They
 * are transport backpressure, not a file error: ordinary quick tab opens get
 * a short bounded retry while genuine read/diff failures render immediately. */
export const isRetryableFileError = (error: string | undefined): boolean =>
  error === "requests are arriving too fast — retry shortly" ||
  error === "a git query is already running — retry shortly";

/** Accept a reply only when it answers the request currently awaited. A
 * superseded click, closed view, or changed session clears/replaces the id,
 * so its late reply can never paint a different file. Pure, for Tier-1. */
export const isCurrentReply = (awaited: string | null, replyId: string): boolean =>
  awaited !== null && awaited === replyId;

/**
 * Reusable controller for Mirafold's shell-owned file presenter. It owns the
 * correlated fs_read/fs_diff request, stale-reply rejection, selected path,
 * mode, and resolved view state. FilesPanel, Changes, and each PN.2 file-pane
 * tab supply their own chrome without duplicating this request lifecycle.
 */
export function useFileView({
  subscribe,
  requestRead,
  requestDiff,
  scopeKey,
}: {
  subscribe: (listener: (message: ZoneMsg) => void) => () => void;
  requestRead: (path: string) => string;
  requestDiff: (path: string) => string;
  /** A session/workspace identity. Changing it invalidates every open file. */
  scopeKey?: string;
}) {
  const [selected, setSelected] = useState<FileSelection | null>(null);
  const [mode, setMode] = useState<FileViewMode>("content");
  const [view, setView] = useState<FileViewState>({ kind: "empty" });
  const requestId = useRef<string | null>(null);
  const pending = useRef<{
    path: string;
    status: string | undefined;
    mode: FileViewMode;
    attempt: number;
  } | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPending = useCallback(() => {
    requestId.current = null;
    pending.current = null;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  const close = useCallback(() => {
    clearPending();
    setSelected(null);
  }, [clearPending]);

  const reset = useCallback(() => {
    clearPending();
    setSelected(null);
    setMode("content");
    setView({ kind: "empty" });
  }, [clearPending]);

  // A transport reconnect can orphan an in-flight reply while keeping the
  // same session identity. Leave the last resolved view visible, but make the
  // lost correlation id non-authoritative so the host can request it afresh.
  const cancelPending = useCallback(() => {
    clearPending();
  }, [clearPending]);

  const issue = useCallback(
    (path: string, status: string | undefined, nextMode: FileViewMode, attempt: number) => {
      clearPending();
      setSelected({ path, status });
      setMode(nextMode);
      // A same-path re-request (live/manual refresh) keeps the resolved view
      // on screen until the fresh reply lands: flipping to "loading" would
      // unmount the presenter mid-read — a flicker, and the reader's place
      // (scroll position, review-position memory) dies with the instance.
      setView((prev) =>
        (prev.kind === (nextMode === "diff" ? "diff" : "content")) && prev.path === path
          ? prev
          : { kind: "loading", path },
      );
      requestId.current = nextMode === "diff" ? requestDiff(path) : requestRead(path);
      pending.current = { path, status, mode: nextMode, attempt };
    },
    [clearPending, requestDiff, requestRead],
  );

  const openFile = useCallback(
    (path: string, status: string | undefined, nextMode: FileViewMode) =>
      issue(path, status, nextMode, 0),
    [issue],
  );

  useEffect(
    () =>
      subscribe((message) => {
        if (message.type === "fs_file") {
          if (!isCurrentReply(requestId.current, message.id)) return;
          const request = pending.current;
          if (message.error && isRetryableFileError(message.error) && request && request.attempt < FILE_RETRY_LIMIT) {
            requestId.current = null;
            retryTimer.current = setTimeout(() => {
              retryTimer.current = null;
              if (pending.current !== request) return;
              issue(request.path, request.status, request.mode, request.attempt + 1);
            }, FILE_RETRY_DELAY_MS);
            return;
          }
          pending.current = null;
          setView(fileToState(message));
        } else if (message.type === "fs_file_diff") {
          if (!isCurrentReply(requestId.current, message.id)) return;
          const request = pending.current;
          if (message.error && isRetryableFileError(message.error) && request && request.attempt < FILE_RETRY_LIMIT) {
            requestId.current = null;
            retryTimer.current = setTimeout(() => {
              retryTimer.current = null;
              if (pending.current !== request) return;
              issue(request.path, request.status, request.mode, request.attempt + 1);
            }, FILE_RETRY_DELAY_MS);
            return;
          }
          pending.current = null;
          setView(diffToState(message));
        }
      }),
    [issue, subscribe],
  );

  useEffect(() => reset(), [scopeKey, reset]);
  useEffect(() => clearPending, [clearPending]);

  return { selected, mode, view, openFile, close, reset, cancelPending };
}
