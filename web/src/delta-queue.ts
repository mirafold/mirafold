import type { WireMsg } from "@protocol";

/** A streamed delta waiting in the output zone's per-frame batch. */
export type QueuedDelta = Extract<WireMsg, { type: "text_delta" | "thinking_delta" }>;

/**
 * Append a streamed delta to the pending batch, merging it into the tail
 * entry when both are the same delta type. The batch replays in arrival
 * order, so a merged entry's text is exactly the concatenation of the
 * deltas it absorbed — the same contract the daemon's coalescer keeps.
 */
export function queueDelta(queue: QueuedDelta[], msg: QueuedDelta): void {
  const last = queue[queue.length - 1];
  if (last && last.type === msg.type) last.text += msg.text;
  else queue.push({ type: msg.type, text: msg.text });
}
