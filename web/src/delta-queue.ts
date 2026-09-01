import type { WireMsg } from "@protocol";
import type { ZoneMsg } from "./session-bus";

/** A streamed delta waiting in the output zone's per-frame batch. */
export type QueuedDelta = Extract<
  WireMsg,
  { type: "text_delta" | "thinking_delta" | "tool_output_delta" }
>;

function sameDeltaLane(left: QueuedDelta, right: QueuedDelta): boolean {
  if (left.type !== right.type || left.parentId !== right.parentId) return false;
  if (left.type === "text_delta" && right.type === "text_delta") {
    return left.phase === right.phase;
  }
  if (left.type === "tool_output_delta" && right.type === "tool_output_delta") {
    return left.id === right.id;
  }
  return true;
}

function copyDelta(msg: QueuedDelta): QueuedDelta {
  if (msg.type === "text_delta") {
    return {
      type: msg.type,
      text: msg.text,
      ...(msg.parentId !== undefined ? { parentId: msg.parentId } : {}),
      ...(msg.phase !== undefined ? { phase: msg.phase } : {}),
    };
  }
  if (msg.type === "tool_output_delta") {
    return {
      type: msg.type,
      id: msg.id,
      text: msg.text,
      ...(msg.parentId !== undefined ? { parentId: msg.parentId } : {}),
    };
  }
  return {
    type: msg.type,
    text: msg.text,
    ...(msg.parentId !== undefined ? { parentId: msg.parentId } : {}),
  };
}

/**
 * Append a streamed delta to the pending batch, merging it into the tail
 * entry when both are the same delta type AND the same origin (prose phase +
 * parent, or tool-call id + parent). The batch replays in arrival order, so a
 * merged entry's text is exactly the concatenation of the deltas it
 * absorbed — the same contract the daemon's coalescer keeps.
 */
export function queueDelta(queue: QueuedDelta[], msg: QueuedDelta): void {
  const last = queue[queue.length - 1];
  if (last && sameDeltaLane(last, msg)) {
    last.text += msg.text;
  } else {
    queue.push(copyDelta(msg));
  }
}

export type TranscriptIngressRuntime = {
  scheduleFrame(run: () => void): () => void;
  scheduleAfter(delayMs: number, run: () => void): () => void;
};

export const browserTranscriptIngressRuntime: TranscriptIngressRuntime = {
  scheduleFrame(run) {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  },
  scheduleAfter(delayMs, run) {
    const id = setTimeout(run, delayMs);
    return () => clearTimeout(id);
  },
};

/**
 * The browser-facing edge of the transcript projection. Deltas wait for the
 * first animation frame or the 50 ms hidden-tab fallback; any non-delta drains
 * that queue and follows it in the same ordered batch. The projection itself
 * therefore knows nothing about subscriptions, timers, frames, or disposal.
 */
export function createTranscriptIngress(
  deliver: (messages: readonly ZoneMsg[]) => void,
  runtime: TranscriptIngressRuntime = browserTranscriptIngressRuntime,
): { accept(message: ZoneMsg): void; dispose(): void } {
  const queue: QueuedDelta[] = [];
  let cancelFrame: (() => void) | null = null;
  let cancelFallback: (() => void) | null = null;
  let disposed = false;

  const cancelScheduledFlush = () => {
    cancelFrame?.();
    cancelFallback?.();
    cancelFrame = null;
    cancelFallback = null;
  };

  const flush = () => {
    cancelScheduledFlush();
    if (queue.length) deliver(queue.splice(0));
  };

  const accept = (message: ZoneMsg) => {
    if (disposed) return;
    if (
      message.type === "text_delta" ||
      message.type === "thinking_delta" ||
      message.type === "tool_output_delta"
    ) {
      queueDelta(queue, message);
      if (cancelFrame === null) {
        cancelFrame = runtime.scheduleFrame(flush);
        cancelFallback = runtime.scheduleAfter(50, flush);
      }
      return;
    }

    cancelScheduledFlush();
    deliver([...queue.splice(0), message]);
  };

  return {
    accept,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelScheduledFlush();
      queue.splice(0);
    },
  };
}
