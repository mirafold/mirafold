/**
 * What the viewer pinned, per session — browser-side convenience state like
 * the theme or the cockpit-panel toggle, so leaving a session and coming
 * back (every cockpit switch is a full navigation) keeps the dock. Wire ids
 * in pin order; an id whose painting never replays again renders nothing.
 * `storage` is injectable so the logic is testable without a DOM.
 */
type PinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const pinsKey = (sessionId: string) => `mirafold-pins-${sessionId}`;

// The stored value is read back as untrusted: anything this origin could
// have written must not make the dock's per-frame lookups unbounded. Far
// above any real dock, and a wire id is a UUID (36 chars) or shorter.
export const PIN_STORE_MAX_PINS = 100;
export const PIN_STORE_MAX_ID_LENGTH = 128;

export function loadPins(sessionId: string, storage: PinStorage = localStorage): string[] {
  try {
    const raw = storage.getItem(pinsKey(sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((id): id is string => typeof id === "string" && id.length <= PIN_STORE_MAX_ID_LENGTH)
      .slice(0, PIN_STORE_MAX_PINS);
  } catch {
    return []; // unreadable storage or a corrupt value: start unpinned
  }
}

export function savePins(sessionId: string, ids: readonly string[], storage: PinStorage = localStorage): void {
  try {
    if (ids.length === 0) storage.removeItem(pinsKey(sessionId));
    else storage.setItem(pinsKey(sessionId), JSON.stringify(ids));
  } catch {
    // Storage unavailable (private mode): pins stay tab-local.
  }
}
