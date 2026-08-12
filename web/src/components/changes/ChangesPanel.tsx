import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { ZoneMsg } from "../../session-bus";
import { useEscapeKey } from "../../use-escape";
import { useFocusTrap } from "../../use-focus-trap";
import { useIsPhone } from "../../use-is-phone";
import { FileView } from "../files/FileView";
import {
  ChangeFileHeader,
  ChangesHeader,
  ChangesRail,
  ReviewProgressControls,
} from "./ChangesChrome";
import { ReviewDiff } from "./ReviewDiff";
import { useChangesController } from "./use-changes-controller";

const WIDTH_KEY = "mirafold-changes-panel-width";
/** The stylesheet's untouched desktop width — also the resize floor. */
const DEFAULT_WIDTH = "clamp(370px, 55vw, 760px)";
/** The drag ceiling reserves a phone-sized conversation column (the phone
 * layout proves ~390px is fully usable) — an absolute reserve, because a
 * percentage cap leaves a useless sliver on laptops and still-cramped space
 * on ultrawides. When the window is too narrow for floor + reserve, CSS
 * clamp() lets the floor win and the handle simply has no travel. */
const WIDTH_RESERVE_PX = 380;
const RESIZE_STEP_PX = 32;

const panelWidthExpr = (px: number): string =>
  `clamp(${DEFAULT_WIDTH}, ${Math.round(px)}px, calc(100% - ${WIDTH_RESERVE_PX}px))`;

const readStoredWidth = (): number | null => {
  try {
    const parsed = Number(localStorage.getItem(WIDTH_KEY) ?? NaN);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export function ChangesPanel({
  open,
  subscribe,
  requestChanges,
  requestRead,
  requestDiff,
  onClose,
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
  onCreateDraft: (text: string) => void;
  promptContainerRef?: RefObject<HTMLElement | null>;
  promptVisible?: boolean;
  rootLabel?: string;
  sessionKey?: string;
}) {
  const {
    set,
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

  const [userWidth, setUserWidth] = useState<number | null>(readStoredWidth);
  const drag = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);
  const [widthNow, setWidthNow] = useState<{ now: number; max: number } | null>(null);

  const persistWidth = (value: number | null) => {
    setUserWidth(value);
    try {
      if (value === null) localStorage.removeItem(WIDTH_KEY);
      else localStorage.setItem(WIDTH_KEY, String(Math.round(value)));
    } catch {
      // Storage may be unavailable; the width still applies for this page.
    }
  };

  // The separator's aria-valuenow/-valuemax track real geometry. Updates are
  // skipped mid-drag: pointer moves mutate the panel style directly (below),
  // and a per-frame React commit would re-render every diff row.
  useEffect(() => {
    if (phone || !open || typeof ResizeObserver === "undefined") return;
    const panel = panelRef.current;
    const zone = panel?.parentElement;
    if (!panel || !zone) return;
    const update = () => {
      if (drag.current) return;
      setWidthNow({
        now: Math.round(panel.getBoundingClientRect().width),
        max: Math.max(370, Math.round(zone.getBoundingClientRect().width - WIDTH_RESERVE_PX)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    observer.observe(zone);
    return () => observer.disconnect();
  }, [phone, open]);

  const applyDragWidth = (px: number) => {
    const panel = panelRef.current;
    if (!panel) return;
    const expr = panelWidthExpr(px);
    panel.style.width = expr;
    panel.style.flexBasis = expr;
  };

  const onResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = panelRef.current?.getBoundingClientRect().width ?? 0;
    drag.current = { startX: event.clientX, startWidth: width, latest: width };
  };
  const onResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current.latest = drag.current.startWidth + (event.clientX - drag.current.startX);
    applyDragWidth(drag.current.latest);
  };
  const onResizePointerEnd = () => {
    if (!drag.current) return;
    const final = drag.current.latest;
    drag.current = null;
    persistWidth(final);
  };
  const stepResize = (delta: number) => {
    const measured = panelRef.current?.getBoundingClientRect().width;
    if (measured !== undefined) persistWidth(measured + delta);
  };

  if (!open) return null;

  return (
    <aside
      className="changes-panel"
      aria-label="Workspace changes"
      ref={panelRef}
      role={phone ? "dialog" : undefined}
      aria-modal={phone && !promptVisible ? true : undefined}
      tabIndex={phone ? -1 : undefined}
      style={
        !phone && userWidth !== null
          ? { width: panelWidthExpr(userWidth), flexBasis: panelWidthExpr(userWidth) }
          : undefined
      }
    >
      <ChangesHeader
        phone={phone}
        loaded={set.loaded}
        itemCount={items.length}
        reviewedCount={reviewedCount}
        headerCount={headerCount}
        pending={set.pending}
        onRefresh={requestSet}
        onClose={onClose}
      />

      {set.error && items.length > 0 && (
        <div className="changes-warning" role="status">
          Refresh failed: {set.error}. Showing the last complete result.
        </div>
      )}
      {incomplete && set.loaded && (
        <div className="changes-warning" role="status">
          This list is incomplete; only the visible changes can be reviewed here.
        </div>
      )}

      <div className="changes-body">
        {!phone && items.length > 0 && (
          <ChangesRail
            repos={set.repos}
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

      {!phone && (
        <div
          className="changes-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the changes panel"
          title="Drag to resize · double-click to reset"
          tabIndex={0}
          aria-valuemin={370}
          aria-valuemax={widthNow?.max}
          aria-valuenow={widthNow?.now}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerEnd}
          onPointerCancel={onResizePointerEnd}
          onDoubleClick={() => persistWidth(null)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") stepResize(RESIZE_STEP_PX);
            else if (event.key === "ArrowLeft") stepResize(-RESIZE_STEP_PX);
            else if (event.key === "Home") persistWidth(null);
            else if (event.key === "End") persistWidth(widthNow?.max ?? Number.MAX_SAFE_INTEGER);
            else return;
            event.preventDefault();
          }}
        />
      )}
    </aside>
  );
}
