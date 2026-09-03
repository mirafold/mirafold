// Wire-contract helpers every adapter composes: the protocol obligations that
// do not depend on any engine's lifecycle. Drive loops (how a turn is pumped,
// aborted, resumed) stay local to each adapter on purpose — these are the
// pieces that must behave identically no matter which engine is underneath.

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionMsg } from "../protocol";
import type { TodoItem } from "./types";

type Emit = (msg: SessionMsg) => void;

export function displayPath(p: string, workspaceDir: string): string {
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(workspaceDir, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

/** Why an ask resolved. Adapters that must answer their engine use it to
 *  tell a resolution they own (answer / timeout / teardown) from one the
 *  engine already knows about (`external`: another client replied; `moot`:
 *  the turn or engine is gone, nobody to reply to). */
export type PermissionResolution = "answer" | "timeout" | "external" | "teardown" | "moot";

/**
 * The in-flight permission asks of one session. protocol.ts's rule for
 * `permission_request` — it MUST resolve visibly, exactly once, on EVERY
 * path (browser answer, timeout, interrupt, close, an external reply) — is
 * structural here: every path funnels through one `finish`, which is the one
 * place `permission_resolved` is emitted.
 */
export class PermissionLedger {
  private pending = new Map<string, (allow: boolean, how: PermissionResolution) => void>();

  constructor(private readonly emit: Emit) {}

  get size(): number {
    return this.pending.size;
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  /** Announce an ask and resolve with the answer. Deny-by-default: an
   *  unanswered ask denies at `timeoutMs`. `onResolve` runs after the
   *  resolution is on the wire and before the promise settles. */
  ask(
    request: { id?: string; tool: string; detail: string; parentId?: string },
    timeoutMs: number,
    onResolve?: (allow: boolean, how: PermissionResolution) => void,
  ): Promise<boolean> {
    const id = request.id ?? randomUUID();
    return new Promise((resolve) => {
      // Settled-once is structural, not a property of the callers: a
      // listener on `permission_resolved` that re-enters the ledger during a
      // denyAll sweep must not resolve one ask twice.
      let settled = false;
      const finish = (allow: boolean, how: PermissionResolution) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        this.emit({ type: "permission_resolved", id, allow });
        onResolve?.(allow, how);
        resolve(allow);
      };
      const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
      this.pending.set(id, finish);
      this.emit({
        type: "permission_request",
        tool: request.tool,
        detail: request.detail,
        id,
        ...(request.parentId ? { parentId: request.parentId } : {}),
      });
    });
  }

  /** The answer for one ask; false when no such ask is pending (a stale tap). */
  resolve(id: string, allow: boolean, how: PermissionResolution = "answer"): boolean {
    const finish = this.pending.get(id);
    if (!finish) return false;
    finish(allow, how);
    return true;
  }

  /** Deny every in-flight ask — interrupt, close, or a turn that ended. */
  denyAll(how: PermissionResolution = "teardown") {
    for (const finish of [...this.pending.values()]) finish(false, how);
  }
}

/**
 * The turn's live checklist painting. Never PAINTS an empty checklist — but
 * once one is on screen this turn, an emptied list must update it, or the
 * painted block freezes showing already-deleted items. The render id is
 * stable for the turn (updates in place) and fresh each turn, so the
 * checklist re-anchors to the latest activity.
 */
export class ChecklistPainter {
  private renderId?: string;

  constructor(private readonly emit: Emit) {}

  paint(todos: TodoItem[]) {
    if (todos.length === 0 && !this.renderId) return;
    this.renderId ??= randomUUID();
    this.emit({ type: "render", component: "todo-list", props: { todos }, id: this.renderId });
  }

  /** Turn boundary: the next turn's list is a new painting. */
  reset() {
    this.renderId = undefined;
  }
}

/**
 * Engines without an instructions hook receive the render-tool guidance on
 * the session's first ACCEPTED prose turn — the only injection point they
 * offer. Mark it `delivered()` only once the engine has accepted the prompt:
 * flipping before the await burns the guidance on a failed first turn, and
 * every later turn runs bare with no render calls for the session's whole
 * life. `reset()` gives it back when a prompt was provably never read, or
 * when the conversation context was replaced.
 */
export class RenderGuidanceOnce {
  private owed = true;

  constructor(private readonly guidance: string) {}

  get pending(): boolean {
    return this.owed;
  }

  /** The prompt to send while the guidance is still owed. */
  carry(text: string): string {
    return this.owed ? `${this.guidance}\n\n---\n\n${text}` : text;
  }

  delivered() {
    this.owed = false;
  }

  reset() {
    this.owed = true;
  }
}

/** A shell-reimplemented slash command uses the same visible turn envelope
 *  as an engine turn: `status: thinking` first, `turn_end` last — even when
 *  the body throws, or the client's busy state wedges. */
export async function runSlashTurn(emit: Emit, body: () => Promise<void> | void): Promise<void> {
  emit({ type: "status", state: "thinking" });
  try {
    await body();
  } finally {
    emit({ type: "turn_end" });
  }
}

// Server-side twin of the web's visibleControls (web/src/visible-controls.ts),
// for engine-chosen identifiers riding inside a shell-voiced sentence or a log
// line: direction and invisible controls become marked ‹U+XXXX› tokens, and
// the identifier is length-clamped, so no engine string can re-order the
// sentence, hide inside it, or become the whole message. Unlike the web
// version this also marks tab/newline — an identifier is single-line — and
// Unicode tag characters (U+E0001, U+E0020–E007F: invisible ASCII smuggling)
// plus interlinear annotation controls. Variation selectors stay: they alter
// a glyph's look but cannot hide or re-order other text.
const CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0001}\u{e0020}-\u{e007f}]/gu;

export function inertToken(value: string, max = 80): string {
  // Clamp by code points BEFORE marking: the clamp itself creates no split
  // surrogate and no half-cut ‹U+…› marker, and the marked result stays
  // bounded. (A lone surrogate already present in the input passes through;
  // JSON encodes it safely and the client renders U+FFFD.)
  const points = Array.from(value);
  const clamped = points.length > max ? `${points.slice(0, max - 1).join("")}…` : value;
  return clamped.replace(
    CONTROL,
    (c) => `‹U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}›`,
  );
}

// Distinct kinds one session will report before going quiet: enough for any
// real version skew (Codex's whole item list is ~19), small enough that an
// erratic engine minting kinds cannot grow the wire or the checkpoint.
export const UNKNOWN_KIND_REPORT_CAP = 25;

/**
 * An engine event kind the adapter has no mapping for is reported — once per
 * kind per session — as a log line and a shell-voiced notice, instead of
 * being dropped. Silence was the failure mode: the Codex app-server rewrite
 * shipped with 12 of 19 item kinds unmapped and nothing said so for a month
 * (Phase TS.7). The notice is Mirafold's own sentence, so it carries no
 * `source` — which is exactly why the kind riding inside it, an engine-chosen
 * string, is clamped and control-visible (inertToken), and why the reporter
 * stops at a hard cap instead of relaying kinds forever.
 */
export class UnknownKindReporter {
  private readonly seen = new Set<string>();
  private overflowed = false;
  constructor(
    private readonly emit: Emit,
    private readonly engine: string,
    private readonly warn: (message: string) => void,
  ) {}

  report(category: string, kind: string) {
    const key = `${category}\u0000${kind}`;
    if (this.seen.has(key)) return;
    if (this.seen.size >= UNKNOWN_KIND_REPORT_CAP) {
      if (this.overflowed) return;
      this.overflowed = true;
      this.warn(`${this.engine}: unknown-kind report cap (${UNKNOWN_KIND_REPORT_CAP}) reached — further kinds unreported`);
      this.emit({
        type: "notice",
        text: `Mirafold has stopped listing unrecognized ${this.engine} events this session (cap reached).`,
        kind: "warning",
      });
      return;
    }
    this.seen.add(key);
    const shown = inertToken(kind);
    this.warn(`${this.engine} ${category} "${shown}" has no Mirafold mapping — not displayed`);
    this.emit({
      type: "notice",
      text: `Mirafold doesn't display this ${this.engine} ${category} yet: ${shown}`,
      kind: "warning",
    });
  }
}
