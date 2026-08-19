import { useRef, type RefObject } from "react";
import type { ZoneMsg } from "../../session-bus";
import { useEscapeKey } from "../../use-escape";
import { useFocusTrap } from "../../use-focus-trap";
import type { WorkspaceSurface } from "../WorkspaceTabs";
import { useIsPhone } from "../../use-is-phone";
import { FileView } from "../files/FileView";
import {
  ChangeFileHeader,
  ChangesHeader,
  ChangesRail,
  ReviewProgressControls,
} from "./ChangesChrome";
import { usePanelResize } from "./panel-resize";
import { ReviewDiff } from "./ReviewDiff";
import { useChangesController } from "./use-changes-controller";

export function ChangesPanel({
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
  } = useChangesController({
    open,
    subscribe,
    requestChanges,
    requestRead,
    requestDiff,
    sessionKey,
  });

  const phone = useIsPhone();
  const panelRef = useRef<HTMLElement>(null);
  const modal = phone && open;
  useFocusTrap(panelRef, modal, promptVisible ? promptContainerRef : undefined);
  useEscapeKey(modal ? onClose : undefined, { exclusive: true });

  const resize = usePanelResize(panelRef, !phone && open);

  if (!open) return null;

  return (
    <aside
      className="changes-panel"
      aria-label="Workspace changes"
      ref={panelRef}
      role={phone ? "dialog" : undefined}
      aria-modal={phone && !promptVisible ? true : undefined}
      tabIndex={phone ? -1 : undefined}
      style={resize.panelStyle}
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
        <div className="changes-warning" role="status">
          Refresh failed: {changeSet.error}. Showing the last complete result.
        </div>
      )}
      {incomplete && changeSet.loaded && (
        <div className="changes-warning" role="status">
          This list is incomplete; only the visible changes can be reviewed here.
        </div>
      )}

      <div className="changes-body">
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

        <section className="changes-review" aria-label="Change review">
          {stateMessage ? (
            <div className="changes-state">
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
                <div className="changes-review-notice" role="status">{reviewNotice}</div>
              )}
              <div
                className="changes-view"
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
