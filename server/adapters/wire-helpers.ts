// Wire-contract helpers every adapter composes: the protocol obligations that
// do not depend on any engine's lifecycle. Drive loops (how a turn is pumped,
// aborted, resumed) stay local to each adapter on purpose — these are the
// pieces that must behave identically no matter which engine is underneath.

import { randomUUID } from "node:crypto";
import type { SessionMsg } from "../protocol";
import type { TodoItem } from "./types";

type Emit = (msg: SessionMsg) => void;

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
      const finish = (allow: boolean, how: PermissionResolution) => {
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
