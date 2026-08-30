import { useRef, type RefObject } from "react";
import { useWorkspacePanelFrame } from "../../use-workspace-panel-frame";
import type { ZoneMsg } from "../../session-bus";
import type { WorkspaceSurface } from "../WorkspaceTabs";
import { useIsPhone } from "../../use-is-phone";
import { FileView } from "../folder-tree/FileView";
import {
  ChangeFileHeader,
  ChangesHeader,
  ChangesRail,
  ReviewProgressControls,
} from "./DiffPanelChrome";
import { usePanelResize } from "./panel-resize";
import { ReviewDiff } from "./ReviewDiff";
import { useDiffPanelController } from "./use-diff-panel-controller";

export function DiffPanel({
  open,
  subscribe,
  requestChanges,
  requestRead,
  requestDiff,
  onClose,
  onSwitch,
  onCreateDraft,
  promptContainerRef,
  promptVisible,
  rootLabel,
  sessionKey,
}: {
  open: boolean;
  subscribe: (listener: (message: ZoneMsg) => void) => () => void;
  requestChanges: () => string;
  requestRead: (path: string) => string;
  requestDiff: (path: string) => string;
  onClose: () => void;
  onSwitch?: (surface: WorkspaceSurface) => void;
  onCreateDraft: (text: string) => void;
  promptContainerRef?: RefObject<HTMLElement | null>;
  promptVisible?: boolean;
  rootLabel?: string;
  sessionKey?: string;
}) {
  const {
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
  } = useDiffPanelController({
    open,
    subscribe,
    requestChanges,
    requestRead,
    requestDiff,
    sessionKey,
  });

  const phone = useIsPhone();
  const panelRef = useRef<HTMLElement>(null);
  const frame = useWorkspacePanelFrame({
    panelRef,
    phone,
    open,
    onEscape: onClose,
    trapExtra: promptVisible ? promptContainerRef : undefined,
    modal: !promptVisible,
  });

  const resize = usePanelResize(panelRef, !phone && open);

  if (!open) return null;

  return (
    <aside
      className="diff-panel-panel"
      aria-label="Workspace changes"
      ref={panelRef}
      style={resize.panelStyle}
      {...frame}
    >
      <ChangesHeader
        phone={phone}
        loaded={changeSet.loaded}
        itemCount={items.length}
        reviewedCount={reviewedCount}
        headerCount={headerCount}
        pending={changeSet.pending}
        onRefresh={requestSet}
        onClose={onClose}
        onSwitch={onSwitch}
      />

      {changeSet.error && items.length > 0 && (
        <div className="diff-panel-warning" role="status">
          Refresh failed: {changeSet.error}. Showing the last complete result.
        </div>
      )}
      {incomplete && changeSet.loaded && (
        <div className="diff-panel-warning" role="status">
          This list is incomplete; only the visible changes can be reviewed here.
        </div>
      )}

      <div className="diff-panel-body">
        {!phone && items.length > 0 && (
          <ChangesRail
            repos={changeSet.repos}
            itemsByPath={itemsByPath}
            selectedPath={file.selected?.path}
            reviewProgress={reviewProgress}
            rootLabel={rootLabel}
            onSelect={select}
          />
        )}

        <section className="diff-panel-review" aria-label="Change review">
          {stateMessage ? (
            <div className="diff-panel-state">
              <strong>{stateMessage.title}</strong>
              <span>{stateMessage.detail}</span>
            </div>
          ) : selectedItem ? (
            <>
              <ChangeFileHeader
                phone={phone}
                item={selectedItem}
                index={selectedIndex}
                itemCount={items.length}
                onMove={move}
              />
              <ReviewProgressControls
                selectedRevision={selectedRevision}
                selectedReviewed={selectedReviewed}
                hasNextUnreviewed={nextUnreviewed >= 0}
                onToggleReviewed={toggleReviewed}
                onNextUnreviewed={goToNextUnreviewed}
              />
              {reviewNotice && (
                <div className="diff-panel-review-notice" role="status">{reviewNotice}</div>
              )}
              <div
                className="diff-panel-view"
                tabIndex={0}
                role="region"
                aria-label={`${selectedItem.path} — diff`}
              >
                {file.view.kind === "diff" ? (
                  <ReviewDiff
                    state={file.view}
                    phone={phone}
                    onCreateDraft={onCreateDraft}
                    selection={reviewSelection}
                    onSelectionChange={setReviewSelection}
                    onNoticeChange={setReviewNotice}
                  />
                ) : (
                  <FileView state={file.view} />
                )}
              </div>
            </>
          ) : null}
        </section>
      </div>

      {resize.handle}
    </aside>
  );
}
