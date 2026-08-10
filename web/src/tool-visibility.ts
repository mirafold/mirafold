export type CompactableTool = {
  id: number;
  batchId: number;
  settled: boolean;
  isError?: boolean;
};

/** Completed successful provider activity collapses only across a contiguous
 * transcript run. A failure, in-flight call, or non-tool row is a boundary:
 * grouping across one would move later work ahead of the visible boundary. */
export function groupSettledTools<T extends CompactableTool>(tools: Array<T | null>): {
  anchors: Map<number, T[]>;
  hidden: Set<number>;
} {
  const anchors = new Map<number, T[]>();
  const hidden = new Set<number>();
  let run: T[] = [];

  const flush = () => {
    if (run.length >= 2) {
      anchors.set(run[0].id, run);
      for (const tool of run.slice(1)) hidden.add(tool.id);
    }
    run = [];
  };

  for (const tool of tools) {
    if (!tool || !tool.settled || tool.isError) {
      flush();
      continue;
    }
    if (run.length && run[0].batchId !== tool.batchId) flush();
    run.push(tool);
  }
  flush();
  return { anchors, hidden };
}
