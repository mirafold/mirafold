export type CompactableTool = {
  id: number;
  batchId: number;
  /** A finished call has a result (success or error); undefined = in flight. */
  output?: unknown;
  isError?: boolean;
  /** The engine's verified read/list/search classification; absent = a
   *  command or call of unknown purpose, which is never grouped. */
  actions?: readonly unknown[];
  /** The command's own exit status when the engine reports one. */
  exitCode?: number;
};

export type ActivityItem<T, K> =
  | { kind: "tool"; tool: T }
  | { kind: "thinking"; thinking: K }
  | null;

export type FoldedActivity<T, K> = Exclude<ActivityItem<T, K>, null>;

/** Is this call ordinary routine work the group may absorb: finished,
 *  successful (no error, no nonzero exit), and classified by the engine as
 *  a read, listing, or search? Anything else is a boundary — a command of
 *  unknown purpose, a failure, an edit, or a call still running. */
export function isRoutineSuccess(tool: CompactableTool): boolean {
  return (
    tool.output !== undefined &&
    !tool.isError &&
    (tool.actions?.length ?? 0) > 0 &&
    (tool.exitCode === undefined || tool.exitCode === 0)
  );
}

/** Contiguous, completed, ordinary routine activity (reads, listings,
 * searches the ENGINE classified as such) collapses into one group — live,
 * as the turn runs: the calls already done fold while the one in flight
 * stays its own visible row beneath. Everything else is a boundary that
 * ends the group: a command of unknown or mixed purpose, an edit, a nonzero
 * exit, a tool error, a running call, a batch (turn) change, and every
 * non-tool transcript row — a message from either side, a painting, a
 * notice. Interior reasoning between two routine calls is absorbed into the
 * group in true transcript order, so expansion replays exactly what
 * happened; leading and trailing reasoning keep their own rows. Nothing is
 * ever reordered, and a failure can never disappear into a success group. */
export function groupToolActivity<T extends CompactableTool, K extends { id: number }>(
  items: Array<ActivityItem<T, K>>,
): { anchors: Map<number, Array<FoldedActivity<T, K>>>; hidden: Set<number> } {
  const anchors = new Map<number, Array<FoldedActivity<T, K>>>();
  const hidden = new Set<number>();
  // `run` always starts with a tool; `interior` holds reasoning rows that are
  // only absorbed once a further routine call proves them interior.
  let run: Array<FoldedActivity<T, K>> = [];
  let runBatch = 0;
  let interior: Array<FoldedActivity<T, K>> = [];

  const idOf = (item: FoldedActivity<T, K>): number =>
    item.kind === "tool" ? item.tool.id : item.thinking.id;

  const flush = () => {
    const toolCount = run.reduce((n, item) => n + (item.kind === "tool" ? 1 : 0), 0);
    if (toolCount >= 2) {
      const first = run[0] as { kind: "tool"; tool: T };
      anchors.set(first.tool.id, run);
      for (const item of run.slice(1)) hidden.add(idOf(item));
    }
    run = [];
    interior = [];
  };

  for (const item of items) {
    if (!item) {
      flush();
      continue;
    }
    if (item.kind !== "tool") {
      if (run.length) interior.push(item);
      continue;
    }
    const tool = item.tool;
    if (!isRoutineSuccess(tool)) {
      flush();
      continue;
    }
    if (run.length && runBatch !== tool.batchId) flush();
    run.push(...interior, item);
    interior = [];
    if (run.length === 1) runBatch = tool.batchId;
  }
  flush();
  return { anchors, hidden };
}
