export type CompactableTool = {
  id: number;
  batchId: number;
  /** A finished call has a result (success or error); undefined = in flight. */
  output?: unknown;
  isError?: boolean;
};

export type ActivityItem<T, K, X = never> =
  | { kind: "tool"; tool: T }
  | { kind: "thinking"; thinking: K }
  | { kind: "text"; text: X }
  | null;

export type FoldedActivity<T, K, X = never> = Exclude<ActivityItem<T, K, X>, null>;

/** Finished, successful provider activity collapses across a contiguous
 * transcript run — live, as the turn runs, not only once it settles: the
 * calls that are already done fold while the one in flight stays its own
 * visible row beneath (the in-flight call is a boundary, never hidden). A
 * failure or a non-narration row is a boundary too: grouping across one would
 * move later work ahead of the visible boundary. Narration is the exception —
 * an engine that talks before every command (Codex does) would otherwise
 * reduce each run to an unfoldable singleton. INTERIOR narration (thinking,
 * and the short assistant text the caller chose to pass as `text`) is
 * absorbed into the fold in true transcript order, so expansion replays
 * exactly what happened; LEADING and TRAILING narration keep their own
 * visible rows — a turn's plan and its conclusion are not "actions", and
 * absorbing them would hide where a turn's reasoning starts. Nothing is ever
 * reordered. */
export function groupToolActivity<T extends CompactableTool, K extends { id: number }, X extends { id: number } = never>(
  items: Array<ActivityItem<T, K, X>>,
): { anchors: Map<number, Array<FoldedActivity<T, K, X>>>; hidden: Set<number> } {
  const anchors = new Map<number, Array<FoldedActivity<T, K, X>>>();
  const hidden = new Set<number>();
  // `run` always starts with a tool; `interior` holds narration rows that are
  // only absorbed once a further tool proves them interior.
  let run: Array<FoldedActivity<T, K, X>> = [];
  let runBatch = 0;
  let interior: Array<FoldedActivity<T, K, X>> = [];

  const idOf = (item: FoldedActivity<T, K, X>): number =>
    item.kind === "tool" ? item.tool.id : item.kind === "thinking" ? item.thinking.id : item.text.id;

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
    if (tool.output === undefined || tool.isError) {
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
