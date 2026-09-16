/**
 * Viewport-local transcript disclosure (Phase TF R6): the session's
 * "details" mode and the reader's explicit open/closed choices, keyed by
 * wire identity (a tool's id, a thinking row's seq) so they survive a row
 * moving into a group, a replay, and a switch away and back in this tab —
 * and never reach other viewers or the daemon's checkpoints. sessionStorage
 * is tab-scoped, which is exactly the boundary wanted; a reload keeps it,
 * a new tab starts compact. `storage` is injectable so the logic is testable
 * without a DOM.
 */
type DisclosureStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const modeKey = (sessionId: string) => `mirafold-details-${sessionId}`;
const choicesKey = (sessionId: string) => `mirafold-disclosure-${sessionId}`;

/** Explicit per-item choices retained per session — newest kept when full. */
export const DISCLOSURE_MAX_ENTRIES = 500;
export const DISCLOSURE_MAX_KEY_LENGTH = 160;

const storageOrNull = (): DisclosureStorage | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

export function loadDetailsMode(sessionId: string, storage: DisclosureStorage | null = storageOrNull()): boolean {
  try {
    return storage?.getItem(modeKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

export function saveDetailsMode(sessionId: string, on: boolean, storage: DisclosureStorage | null = storageOrNull()): void {
  try {
    if (on) storage?.setItem(modeKey(sessionId), "1");
    else storage?.removeItem(modeKey(sessionId));
  } catch {
    // Storage unavailable (private mode): the mode stays component state.
  }
}

export function loadDisclosure(
  sessionId: string,
  storage: DisclosureStorage | null = storageOrNull(),
): Map<string, boolean> {
  try {
    const raw = storage?.getItem(choicesKey(sessionId));
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const out = new Map<string, boolean>();
    for (const entry of parsed) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "boolean") continue;
      if (entry[0].length > DISCLOSURE_MAX_KEY_LENGTH) continue;
      out.set(entry[0], entry[1]);
      if (out.size >= DISCLOSURE_MAX_ENTRIES) break;
    }
    return out;
  } catch {
    return new Map();
  }
}

export function saveDisclosure(
  sessionId: string,
  choices: ReadonlyMap<string, boolean>,
  storage: DisclosureStorage | null = storageOrNull(),
): void {
  try {
    if (choices.size === 0) {
      storage?.removeItem(choicesKey(sessionId));
      return;
    }
    const entries = [...choices].slice(-DISCLOSURE_MAX_ENTRIES);
    storage?.setItem(choicesKey(sessionId), JSON.stringify(entries));
  } catch {
    // Storage unavailable: choices stay tab-local for this mount.
  }
}

/** Record one explicit choice, bounded: the oldest choice leaves when full,
 *  and re-choosing an item moves it to the newest slot. */
export function withChoice(
  choices: ReadonlyMap<string, boolean>,
  key: string,
  expanded: boolean,
): Map<string, boolean> {
  const next = new Map(choices);
  next.delete(key);
  next.set(key, expanded);
  while (next.size > DISCLOSURE_MAX_ENTRIES) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}
