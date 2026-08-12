export type CompactableTool = {
  id: number;
  batchId: number;
  settled: boolean;
  isError?: boolean;
};

export type ActivityItem<T, K> =
  | { kind: "tool"; tool: T }
  | { kind: "thinking"; thinking: K }
  | null;

export type FoldedActivity<T, K> = Exclude<ActivityItem<T, K>, null>;

/** Completed successful provider activity collapses only across a contiguous
 * transcript run. A failure, in-flight call, or non-tool row is a boundary:
 * grouping across one would move later work ahead of the visible boundary.
 * Thinking rows are the one exception — an engine that narrates before every
 * command (Codex does) would otherwise reduce each run to an unfoldable
 * singleton. INTERIOR thinking is absorbed into the fold in true transcript
 * order, so expansion replays exactly what happened; LEADING and TRAILING
 * thinking keep their own visible rows — a turn's plan and its conclusion are
 * not "actions", and absorbing them would hide where a turn's reasoning
 * starts. Nothing is ever reordered. */
export function groupSettledTools<T extends CompactableTool, K extends { id: number }>(
  items: Array<ActivityItem<T, K>>,
): { anchors: Map<number, Array<FoldedActivity<T, K>>>; hidden: Set<number> } {
  const anchors = new Map<number, Array<FoldedActivity<T, K>>>();
  const hidden = new Set<number>();
  // `run` always starts with a tool; `interior` holds thinking rows that are
  // only absorbed once a further tool proves them interior.
  let run: Array<FoldedActivity<T, K>> = [];
  let runBatch = 0;
  let interior: Array<{ kind: "thinking"; thinking: K }> = [];

  const flush = () => {
    const toolCount = run.reduce((n, item) => n + (item.kind === "tool" ? 1 : 0), 0);
    if (toolCount >= 2) {
      const first = run[0] as { kind: "tool"; tool: T };
      anchors.set(first.tool.id, run);
      for (const item of run.slice(1)) {
        hidden.add(item.kind === "tool" ? item.tool.id : item.thinking.id);
      }
    }
    run = [];
    interior = [];
  };

  for (const item of items) {
    if (!item) {
      flush();
      continue;
    }
    if (item.kind === "thinking") {
      if (run.length) interior.push(item);
      continue;
    }
    const tool = item.tool;
    if (!tool.settled || tool.isError) {
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
