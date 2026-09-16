/**
 * The shell's ledger of task states it has already seen, so a completion
 * note (and its screen-reader announcement) fires on a TRANSITION only.
 * Replayed frames are recorded too — a reload must not forget what it
 * already showed, or the engine's next republication of the same terminal
 * state (a Codex collab poll repeating a child's `completed`) would read as
 * news (release review, 0.10.0). Whether to NOTE is the caller's: only a
 * live transition into a terminal state is.
 */
export const TASK_LEDGER_CAP = 2_000;

/** Record `state` for `id`; true when it differs from what the ledger held. */
export function recordTaskState(noted: Map<string, string>, id: string, state: string): boolean {
  if (noted.get(id) === state) return false;
  if (!noted.has(id) && noted.size >= TASK_LEDGER_CAP) noted.delete(noted.keys().next().value as string);
  noted.set(id, state);
  return true;
}

/** The note to show for a task frame: only a live transition into a
 *  terminal state says anything; a replayed frame is remembered silently. */
export function taskNoteFor(
  noted: Map<string, string>,
  frame: { id: string; state: string; label?: string; replay?: boolean },
): { text: string; failed: boolean } | null {
  const changed = recordTaskState(noted, frame.id, frame.state);
  // `unknown` is the contract's "no lifecycle evidence": remembered for the
  // ledger, never spoken as an ending (release review 0.10.0).
  if (!changed || frame.replay || frame.state === "running" || frame.state === "unknown") return null;
  const what = frame.label ?? "a task";
  const word = frame.state === "completed" ? "finished" : frame.state === "failed" ? "failed" : "was interrupted";
  return { text: `${what} ${word}`, failed: frame.state === "failed" };
}
