export type InputNavigationDirection = "older" | "newer";

type InputRowCandidate = { kind: string; role?: string };

/** User-authored command strips are stops; output and shell rows are not. */
export function isNavigableInputRow(row: InputRowCandidate): boolean {
  return row.kind === "bang" || (row.kind === "text" && row.role === "user");
}

/** Return the adjacent chronological stop without wrapping. */
export function adjacentInputIndex(
  current: number,
  total: number,
  direction: InputNavigationDirection,
): number | null {
  if (!Number.isInteger(current) || !Number.isInteger(total) || total <= 0) return null;
  if (current < 0 || current >= total) return null;
  const target = current + (direction === "older" ? -1 : 1);
  return target >= 0 && target < total ? target : null;
}

/**
 * The input governing a viewport is the newest input at or above its reading
 * edge. Before the first input, the first one is the only meaningful anchor.
 * DOM order supplies the already-sorted top coordinates.
 */
export function inputIndexAtViewport(
  inputTops: readonly number[],
  readingEdge: number,
): number | null {
  if (inputTops.length === 0) return null;
  let current = 0;
  for (let index = 0; index < inputTops.length; index += 1) {
    if (inputTops[index] > readingEdge) break;
    current = index;
  }
  return current;
}
