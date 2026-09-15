import type { SessionMsg } from "../protocol";
import { OUTPUT_CAP_BYTES, splitBudget, utf8Prefix, utf8Suffix } from "./types";

// Reaching the live-output ceiling is said once on the legacy stream itself:
// an interrupted command settles from that stream on a pre-TF client, and a
// silent cut would read as "that was all the output" (release review
// 2026-09-01).
export const streamCapMarker = (cap: number) =>
  `\n(… live output capped at ${Math.round(cap / 1000)} KB — the settled result reports how much was cut …)`;
export const STREAM_CAP_MARKER = streamCapMarker(OUTPUT_CAP_BYTES);

/** Replacement snapshots go out at most this often per running call; the
 *  final flush at settlement is immediate. */
export const SNAPSHOT_INTERVAL_MS = 250;

// Distinct running calls tracked at once — flood insurance in the part-cap
// spirit: an engine that announces unbounded ids must not grow memory here.
const MAX_TRACKED = 2_000;

type Track = {
  parentId?: string;
  // Everything observed while under the cap; once over it, `head` is fixed
  // and `tail` advances as a bounded window over the newest bytes.
  whole: Buffer[];
  wholeBytes: number;
  head?: string;
  tail: Buffer[];
  tailBytes: number;
  totalBytes: number;
  revision: number;
  dirty: boolean;
  timer?: NodeJS.Timeout;
  lastEmitAt: number;
  // The legacy bounded prefix (tool_output_delta): bytes already sent and
  // whether the ceiling marker went out.
  legacySent: number;
  legacyMarked: boolean;
  // For replacement-fed engines (OpenCode): the last full text observed,
  // so the next full text yields only its new suffix.
  seen: string;
};

/**
 * The bounded live-output accumulator every streaming adapter shares (Phase
 * TF): per running call it keeps a UTF-8-safe head and an advancing tail
 * within the output budget, emits throttled `tool_output_snapshot`
 * replacements with a monotonic revision, and keeps the legacy bounded
 * `tool_output_delta` prefix flowing for clients that predate snapshots.
 * `settle` flushes the final snapshot immediately and forgets the call;
 * `clear` does that for every call at teardown so no timer outlives its
 * session.
 */
export class LiveOutput {
  private tracks = new Map<string, Track>();
  private readonly cap: number;
  private readonly interval: number;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      emit: (msg: SessionMsg) => void;
      capBytes?: number;
      intervalMs?: number;
      /** Send the legacy bounded prefix too (default on). */
      legacyDeltas?: boolean;
      now?: () => number;
    },
  ) {
    this.cap = Math.max(0, options.capBytes ?? OUTPUT_CAP_BYTES);
    this.interval = options.intervalMs ?? SNAPSHOT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  has(id: string): boolean {
    return this.tracks.has(id);
  }

  /** New bytes of a running call's output arrived. */
  append(id: string, text: string, parentId?: string): void {
    if (!text) return;
    const track = this.track(id, parentId);
    if (!track) return;
    this.legacyDelta(id, track, text);
    this.absorb(track, Buffer.from(text, "utf8"));
    track.seen += text;
    this.schedule(id, track);
  }

  /** The engine republished the WHOLE output so far (OpenCode's running
   *  `metadata.output`): only the suffix beyond what was seen is new; a
   *  text that no longer extends the previous one is a reset. */
  replace(id: string, full: string, parentId?: string): void {
    const track = this.track(id, parentId);
    if (!track) return;
    if (full === track.seen) return;
    if (full.startsWith(track.seen)) {
      const suffix = full.slice(track.seen.length);
      track.seen = full;
      if (!suffix) return;
      this.legacyDelta(id, track, suffix);
      this.absorb(track, Buffer.from(suffix, "utf8"));
      this.schedule(id, track);
      return;
    }
    // Reset: the engine started over (its own buffer rolled to a file).
    // The head already observed stays; the tail follows the new text.
    track.seen = full;
    if (!full) return;
    this.legacyDelta(id, track, full);
    this.absorb(track, Buffer.from(full, "utf8"));
    this.schedule(id, track);
  }

  /** The call settled (or was interrupted): flush the final snapshot now
   *  and forget it. Later bytes for the id start a fresh track. */
  settle(id: string): void {
    const track = this.tracks.get(id);
    if (!track) return;
    clearTimeout(track.timer);
    if (track.dirty) this.emitSnapshot(id, track);
    this.tracks.delete(id);
  }

  /** Teardown: every running call flushes and is forgotten. */
  clear(): void {
    for (const id of [...this.tracks.keys()]) this.settle(id);
  }

  private track(id: string, parentId?: string): Track | undefined {
    let track = this.tracks.get(id);
    if (!track) {
      if (this.tracks.size >= MAX_TRACKED) return undefined;
      track = {
        parentId,
        whole: [],
        wholeBytes: 0,
        tail: [],
        tailBytes: 0,
        totalBytes: 0,
        revision: 0,
        dirty: false,
        lastEmitAt: -Infinity,
        legacySent: 0,
        legacyMarked: false,
        seen: "",
      };
      this.tracks.set(id, track);
    }
    return track;
  }

  private absorb(track: Track, bytes: Buffer): void {
    track.totalBytes += bytes.length;
    track.dirty = true;
    const { head, tail } = splitBudget(this.cap);
    if (track.head === undefined) {
      track.whole.push(bytes);
      track.wholeBytes += bytes.length;
      if (track.wholeBytes <= this.cap) return;
      // Crossing the cap: freeze the head, seed the tail window.
      const all = Buffer.concat(track.whole);
      track.whole = [];
      track.wholeBytes = 0;
      track.head = utf8Prefix(all, head);
      track.tail = [all.subarray(Math.max(0, all.length - tail))];
      track.tailBytes = track.tail[0]!.length;
      return;
    }
    track.tail.push(bytes);
    track.tailBytes += bytes.length;
    // Trim whole chunks off the front while the window still holds `tail`
    // bytes; a straddling chunk is sliced.
    while (track.tailBytes > tail && track.tail.length) {
      const first = track.tail[0]!;
      const excess = track.tailBytes - tail;
      if (first.length <= excess) {
        track.tail.shift();
        track.tailBytes -= first.length;
      } else {
        track.tail[0] = first.subarray(excess);
        track.tailBytes -= excess;
      }
    }
  }

  private legacyDelta(id: string, track: Track, text: string): void {
    if (this.options.legacyDeltas === false) return;
    const cap = this.cap;
    const marker = track.legacyMarked ? "" : streamCapMarker(cap);
    const parent = track.parentId ? { parentId: track.parentId } : {};
    if (track.legacySent >= cap) {
      // Past the ceiling nothing more streams — but the ceiling itself is
      // said once, even when it was zero to begin with.
      if (marker) {
        track.legacyMarked = true;
        this.options.emit({ type: "tool_output_delta", id, text: marker, ...parent });
      }
      return;
    }
    const room = cap - track.legacySent;
    const bytes = Buffer.from(text, "utf8");
    const truncated = bytes.length > room;
    const reached = bytes.length >= room;
    const sent = truncated ? utf8Prefix(bytes, room) : text;
    track.legacySent = reached ? cap : track.legacySent + bytes.length;
    if (reached) track.legacyMarked = true;
    this.options.emit({ type: "tool_output_delta", id, text: sent + (reached ? marker : ""), ...parent });
  }

  private schedule(id: string, track: Track): void {
    if (track.timer) return;
    const due = track.lastEmitAt + this.interval - this.now();
    if (due <= 0) {
      this.emitSnapshot(id, track);
      return;
    }
    track.timer = setTimeout(() => {
      track.timer = undefined;
      if (track.dirty) this.emitSnapshot(id, track);
    }, due);
    track.timer.unref();
  }

  private emitSnapshot(id: string, track: Track): void {
    track.dirty = false;
    track.lastEmitAt = this.now();
    track.revision += 1;
    this.options.emit({ type: "tool_output_snapshot", id, revision: track.revision, ...snapshotBody(track, this.cap) });
  }
}

function snapshotBody(track: Track, cap: number): { head: string; tail?: string; omittedBytes?: number; parentId?: string } {
  const parent = track.parentId ? { parentId: track.parentId } : {};
  if (track.head === undefined) {
    return { head: utf8Prefix(Buffer.concat(track.whole), cap), ...parent };
  }
  const { tail } = splitBudget(cap);
  const tailText = utf8Suffix(Buffer.concat(track.tail), tail);
  const headBytes = Buffer.byteLength(track.head, "utf8");
  const tailBytes = Buffer.byteLength(tailText, "utf8");
  const omittedBytes = Math.max(0, track.totalBytes - headBytes - tailBytes);
  return {
    head: track.head,
    ...(tailText ? { tail: tailText } : {}),
    ...(omittedBytes > 0 ? { omittedBytes } : {}),
    ...parent,
  };
}
