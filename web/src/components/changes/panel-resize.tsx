import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

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

/** The desktop Changes panel's drag-to-resize concern: floor = the default
 * width, ceiling = full width minus the conversation reserve, persisted per
 * browser. Returns the panel's inline style and the separator element to
 * render inside the panel (null while disabled, e.g. on phone). */
export function usePanelResize(
  panelRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): { panelStyle: CSSProperties | undefined; handle: ReactNode } {
  const [userWidth, setUserWidth] = useState<number | null>(readStoredWidth);
  const drag = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);
  const [bounds, setBounds] = useState<{ now: number; max: number } | null>(null);

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
    if (!enabled || typeof ResizeObserver === "undefined") return;
    const panel = panelRef.current;
    const zone = panel?.parentElement;
    if (!panel || !zone) return;
    const update = () => {
      if (drag.current) return;
      setBounds({
        now: Math.round(panel.getBoundingClientRect().width),
        max: Math.max(370, Math.round(zone.getBoundingClientRect().width - WIDTH_RESERVE_PX)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    observer.observe(zone);
    return () => observer.disconnect();
  }, [enabled, panelRef]);

  const applyDragWidth = (px: number) => {
    const panel = panelRef.current;
    if (!panel) return;
    const expr = panelWidthExpr(px);
    panel.style.width = expr;
    panel.style.flexBasis = expr;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = panelRef.current?.getBoundingClientRect().width ?? 0;
    drag.current = { startX: event.clientX, startWidth: width, latest: width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current.latest = drag.current.startWidth + (event.clientX - drag.current.startX);
    applyDragWidth(drag.current.latest);
  };
  const onPointerEnd = () => {
    if (!drag.current) return;
    const final = drag.current.latest;
    drag.current = null;
    persistWidth(final);
  };
  const step = (delta: number) => {
    const measured = panelRef.current?.getBoundingClientRect().width;
    if (measured !== undefined) persistWidth(measured + delta);
  };

  const panelStyle =
    enabled && userWidth !== null
      ? { width: panelWidthExpr(userWidth), flexBasis: panelWidthExpr(userWidth) }
      : undefined;

  const handle = enabled ? (
    <div
      className="changes-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the changes panel"
      title="Drag to resize · double-click to reset"
      tabIndex={0}
      aria-valuemin={370}
      aria-valuemax={bounds?.max}
      aria-valuenow={bounds?.now}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={() => persistWidth(null)}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") step(RESIZE_STEP_PX);
        else if (event.key === "ArrowLeft") step(-RESIZE_STEP_PX);
        else if (event.key === "Home") persistWidth(null);
        else if (event.key === "End") persistWidth(bounds?.max ?? Number.MAX_SAFE_INTEGER);
        else return;
        event.preventDefault();
      }}
    />
  ) : null;

  return { panelStyle, handle };
}
