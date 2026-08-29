import type { SessionMsg } from "../protocol";
import { BUFFER_CAP, BUFFER_MAX_BYTES } from "./limits";

/** Rough retained size of a buffered message. JSON length is the honest proxy
 *  for the payloads that matter here (a data: URI is one long string) and
 *  costs one serialization per broadcast — the same work the verbose logger
 *  already does per message. */
export function msgBytes(msg: SessionMsg): number {
  return Buffer.byteLength(JSON.stringify(msg));
}

type Delta = Extract<SessionMsg, { type: "text_delta" | "thinking_delta" }>;

/**
 * One session's sequenced replay ring: the retained tail of the session
 * stream, capped by count and by bytes (oldest evict first), with the
 * resume-cursor rules and the delta-coalescing window that decides what
 * enters it. Owning these together keeps three invariants in one place:
 * `bytes` is always Σ msgBytes(buffer); every retained message carries the
 * seq it was delivered under; and the window is always flushed before the
 * ring is read (replay) or persisted — an open window would otherwise hold
 * the transcript's tail past the replay.
 *
 * The ring delivers through `deliver` — the registry's fan-out/checkpoint
 * path — so stream order is exactly the adapter's: a delta of the other type,
 * a different subagent's delta, or any non-delta message flushes the window
 * before it is delivered.
 */
export class ReplayRing {
  buffer: SessionMsg[] = [];
  bytes = 0;
  nextSeq = 1;
  /** A tail cursor is meaningful only inside one daemon's stream epoch. A
   *  checkpoint can lag already-fanned high-volume frames by the debounce
   *  window, so a session reopened from disk must full-replay for this
   *  engine lifetime instead of comparing a prior daemon's cursor to reused
   *  seqs. */
  tailResumeSafe = true;
  private pendingDelta?: Delta;
  private deltaTimer?: NodeJS.Timeout;

  constructor(
    private readonly opts: {
      /** The coalescing window; 0 = every delta passes straight through. */
      coalesceMs: number;
      deliver: (msg: SessionMsg) => void;
      countCap?: number;
      byteCap?: number;
    },
  ) {}

  /** A ring rebuilt from a checkpoint: full-replay only for this lifetime. */
  static restore(buffer: SessionMsg[], nextSeq: number, opts: ReplayRing["opts"]): ReplayRing {
    const ring = new ReplayRing(opts);
    ring.buffer = buffer;
    ring.bytes = buffer.reduce((sum, msg) => sum + msgBytes(msg), 0);
    ring.nextSeq = nextSeq;
    ring.tailResumeSafe = false;
    ring.trim();
    return ring;
  }

  /** Route a message into the stream: consecutive same-lane deltas merge
   *  inside the window into one message whose text is their concatenation;
   *  anything else flushes the window first, then delivers. */
  offer(msg: SessionMsg) {
    if (this.opts.coalesceMs > 0 && (msg.type === "text_delta" || msg.type === "thinking_delta")) {
      const pending = this.pendingDelta;
      // The merge key is (type, parentId): with parallel subagents streaming,
      // merging on type alone would concatenate one agent's prose into
      // another's (or into the parent's) inside a single message.
      if (pending && pending.type === msg.type && pending.parentId === msg.parentId) {
        pending.text += msg.text;
        return;
      }
      this.flush();
      this.pendingDelta = {
        type: msg.type,
        text: msg.text,
        ...(msg.parentId !== undefined ? { parentId: msg.parentId } : {}),
      };
      this.deltaTimer = setTimeout(() => this.flush(), this.opts.coalesceMs);
      this.deltaTimer.unref();
      return;
    }
    this.flush();
    this.opts.deliver(msg);
  }

  /** Deliver whatever delta text the open window holds, in stream position. */
  flush() {
    clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    const pending = this.pendingDelta;
    if (!pending) return;
    this.pendingDelta = undefined;
    this.opts.deliver(pending);
  }

  /** Stamp the resume cursor onto a shallow copy, retain it, and evict past
   *  the caps. The adapter's own object never carries a seq, so re-emitting
   *  it can't corrupt an already-buffered one; nested objects (render props,
   *  tool input) stay shared, so an adapter must not mutate a message after
   *  emitting it. Returns the stamped copy. */
  push(msg: SessionMsg): SessionMsg {
    const stamped = { ...msg, seq: this.nextSeq++ };
    this.buffer.push(stamped);
    this.bytes += msgBytes(stamped);
    this.trim();
    return stamped;
  }

  /** Evict oldest-first until the ring is under both caps. */
  trim() {
    const countCap = this.opts.countCap ?? BUFFER_CAP;
    const byteCap = this.opts.byteCap ?? BUFFER_MAX_BYTES;
    if (this.buffer.length > countCap) {
      for (const dropped of this.buffer.splice(0, this.buffer.length - countCap)) {
        this.bytes -= msgBytes(dropped);
      }
    }
    // Byte cap: drop oldest until under budget, but never the message just
    // buffered — a single payload over the whole budget still replays (it is
    // already bounded at its source, e.g. the image resolver's 2 MB cap).
    while (this.bytes > byteCap && this.buffer.length > 1) {
      this.bytes -= msgBytes(this.buffer.shift()!);
    }
  }

  /** Can a viewport that last saw `afterSeq` resume with a tail replay? Only
   *  if nothing after it has fallen off the ring, and it isn't from some
   *  other life (a seq we never issued). The window is flushed FIRST: the
   *  replay that follows a yes flushes too, and at a cap that flush evicts
   *  the oldest message — judged against the pre-flush edge, a cursor there
   *  would resume past a hole the viewport never learns about (review
   *  2026-08-29). */
  canResume(afterSeq: number): boolean {
    this.flush();
    if (!this.tailResumeSafe) return false;
    if (!Number.isInteger(afterSeq) || afterSeq < 0 || afterSeq >= this.nextSeq) return false;
    const firstBuffered = this.buffer[0]?.seq ?? this.nextSeq;
    return afterSeq >= firstBuffered - 1;
  }

  /** The retained history a viewport must paint — everything, or only the
   *  tail past `afterSeq` (pre-validated via canResume). Each message is
   *  stamped `replay: true` on a copy at replay time: the client paints
   *  history identically but suppresses live-only side effects. The ring
   *  itself stays unstamped. The window is flushed first so the tail is
   *  complete. */
  replayAfter(afterSeq?: number): SessionMsg[] {
    this.flush();
    const out: SessionMsg[] = [];
    for (const msg of this.buffer) {
      if (afterSeq === undefined || (msg.seq ?? 0) > afterSeq) out.push({ ...msg, replay: true });
    }
    return out;
  }
}
