import { useCallback, useEffect, useRef, useState } from "react";
import type { ZoneMsg } from "../../session-bus";
import { diffToState, fileToState, type FileViewState } from "./FileView";

export type FileViewMode = "content" | "diff";
export type FileSelection = { path: string; status?: string };

/** Accept a reply only when it answers the request currently awaited. A
 * superseded click, closed view, or changed session clears/replaces the id,
 * so its late reply can never paint a different file. Pure, for Tier-1. */
export const isCurrentReply = (awaited: string | null, replyId: string): boolean =>
  awaited !== null && awaited === replyId;

/**
 * Reusable controller for Mirafold's shell-owned file presenter. It owns the
 * correlated fs_read/fs_diff request, stale-reply rejection, selected path,
 * mode, and resolved view state. FilesPanel supplies Explorer chrome today;
 * the Changes workspace can supply review chrome without duplicating this
 * request lifecycle in CR.2.
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

  const close = useCallback(() => {
    requestId.current = null;
    setSelected(null);
  }, []);

  const reset = useCallback(() => {
    requestId.current = null;
    setSelected(null);
    setMode("content");
    setView({ kind: "empty" });
  }, []);

  const openFile = useCallback(
    (path: string, status: string | undefined, nextMode: FileViewMode) => {
      setSelected({ path, status });
      setMode(nextMode);
      setView({ kind: "loading", path });
      requestId.current = nextMode === "diff" ? requestDiff(path) : requestRead(path);
    },
    [requestDiff, requestRead],
  );

  useEffect(
    () =>
      subscribe((message) => {
        if (message.type === "fs_file") {
          if (!isCurrentReply(requestId.current, message.id)) return;
          setView(fileToState(message));
        } else if (message.type === "fs_file_diff") {
          if (!isCurrentReply(requestId.current, message.id)) return;
          setView(diffToState(message));
        }
      }),
    [subscribe],
  );

  useEffect(() => reset(), [scopeKey, reset]);

  return { selected, mode, view, openFile, close, reset };
}
