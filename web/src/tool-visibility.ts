export type CompactableTool = {
  id: number;
  batchId: number;
  settled: boolean;
  isError?: boolean;
};

/** Completed successful provider activity collapses per turn. Failures and
 * in-flight calls never enter a group, so the default surface remains honest. */
export function groupSettledTools<T extends CompactableTool>(tools: T[]): {
  anchors: Map<number, T[]>;
  hidden: Set<number>;
} {
  const batches = new Map<number, T[]>();
  for (const tool of tools) {
    if (!tool.settled || tool.isError) continue;
    const batch = batches.get(tool.batchId) ?? [];
    batch.push(tool);
    batches.set(tool.batchId, batch);
  }
  const anchors = new Map<number, T[]>();
  const hidden = new Set<number>();
  for (const batch of batches.values()) {
    if (batch.length < 2) continue;
    anchors.set(batch[0].id, batch);
    for (const tool of batch.slice(1)) hidden.add(tool.id);
  }
  return { anchors, hidden };
}
