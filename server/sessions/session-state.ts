import type { SessionMeta, SessionMsg } from "../protocol";
import { PERMISSION_TIMEOUT_MS } from "../adapters/types";

// Cap on the fleet's pending-permission MIRROR: a flooded session — a hostile
// or steered model spamming permissioned tool calls — must not grow watcher
// snapshots without bound (500 asks × full detail ≈ 1 MB to every watcher, up
// to 10×/s). Oldest evict first: they're closest to the adapter's auto-deny,
// and an evicted ask stays answerable at the adapter — only the fleet's view
// of it is dropped; in-session viewports saw its permission_request
// regardless. Each KEPT entry still carries its full, untruncated detail.
export const PERMISSION_MIRROR_CAP = 25;

export type PendingPermission = { id: string; tool: string; detail: string; askedAt: number };
export type SessionUsage = { inputTokens: number; outputTokens: number; costUsd?: number };

/**
 * What a session is doing, derived from its own stream — no adapter
 * cooperation needed: the fleet's coarse `status`, the prompt-burst gate's
 * turn counters, and the cockpit's activity / pending-ask / usage mirror.
 */
export type SessionActivityState = {
  status: SessionMeta["status"];
  // Enqueued + running model turns, independent from the composite status:
  // a permission hold or a `!` PTY can temporarily own `status` while model
  // work remains underneath. Never persisted — recovery starts idle.
  modelTurnsPending: number;
  // Adapters emit error + turn_end for one failed turn. The error provides
  // immediate terminal feedback; this marker keeps its following turn_end
  // from decrementing the pending count a second time.
  errorAwaitingTurnEnd: boolean;
  // What the session is doing RIGHT NOW ("thinking", a tool name, "! <cmd>");
  // `since` is when that label started. Absent when idle.
  activity?: { label: string; since: number };
  // The pending-permission queue, oldest first. Each entry lives until ITS
  // OWN resolution; `askedAt` mirrors the adapter's auto-deny deadline.
  permissions: PendingPermission[];
  usage?: SessionUsage;
};

export type SessionStateInput =
  | { kind: "message"; msg: SessionMsg }
  // dispatchPrompt / a `!` transcript handed to the engine: one more model
  // turn is enqueued or running.
  | { kind: "prompt_accepted" }
  // answerPermission: the answered id leaves the mirror immediately (honest
  // feedback before the stream moves — the allowed tool may take a moment).
  | { kind: "permission_answered"; id: string };

export const IDLE_STATE: SessionActivityState = {
  status: "idle",
  modelTurnsPending: 0,
  errorAwaitingTurnEnd: false,
  permissions: [],
};

/**
 * Fold one per-turn `usage` report into the session total — the status
 * bar's exact rule: tokens are per-turn and SUM; costUsd arrives
 * session-cumulative and is TAKEN, never summed (a later report without a
 * cost keeps the last one).
 */
export function foldUsage(
  prev: SessionUsage | undefined,
  msg: { inputTokens: number; outputTokens: number; costUsd?: number },
): SessionUsage {
  const costUsd = msg.costUsd ?? prev?.costUsd;
  return {
    inputTokens: (prev?.inputTokens ?? 0) + msg.inputTokens,
    outputTokens: (prev?.outputTokens ?? 0) + msg.outputTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * The one rule for "what does the session look like after this": a pure
 * reducer over the stream. `watchersChanged` is true when fleet-visible
 * metadata moved (status, activity label, pending-ask count, usage).
 *
 * Terminal states first; a permission hold sticks until the turn moves
 * again; `!` bang traffic runs BESIDE the model turn and is never turn
 * grammar (its end must not lift a hold, wipe the ask mirror, or reopen the
 * burst gate); a permission_resolved lifts the hold only when nothing else
 * pends; a turn's terminal event drops every ask it owned.
 */
export function reduceSessionState(
  prev: SessionActivityState,
  input: SessionStateInput,
  now: number = Date.now(),
): { state: SessionActivityState; watchersChanged: boolean } {
  if (input.kind === "prompt_accepted") {
    return {
      state: { ...prev, modelTurnsPending: prev.modelTurnsPending + 1, errorAwaitingTurnEnd: false },
      watchersChanged: false,
    };
  }
  if (input.kind === "permission_answered") {
    const permissions = prev.permissions.filter((p) => p.id !== input.id);
    return {
      state: { ...prev, permissions },
      watchersChanged: permissions.length !== prev.permissions.length,
    };
  }
  const { msg } = input;
  const next: SessionActivityState = { ...prev, permissions: prev.permissions };

  // ---- coarse status + the turn counters ----
  if (msg.type === "turn_end" || msg.type === "error") {
    if (msg.type === "error") {
      if (!next.errorAwaitingTurnEnd) {
        next.modelTurnsPending = Math.max(0, next.modelTurnsPending - 1);
      }
      next.errorAwaitingTurnEnd = true;
    } else if (next.errorAwaitingTurnEnd) {
      next.errorAwaitingTurnEnd = false;
    } else {
      next.modelTurnsPending = Math.max(0, next.modelTurnsPending - 1);
    }
    next.status = next.modelTurnsPending > 0 ? "working" : "idle";
  } else if (msg.type === "bang_end") {
    next.status = next.permissions.length
      ? "permission"
      : next.modelTurnsPending > 0
        ? "working"
        : "idle";
  } else if (msg.type === "permission_request") {
    next.status = "permission";
  } else if (msg.type === "bang_start" || msg.type === "bang_output") {
    if (next.status !== "permission") next.status = "working";
  } else if (msg.type !== "permission_resolved") {
    // permission_resolved decides its own status below — it must not
    // blanket-flip to "working" while a SECOND ask still pends.
    next.status = "working";
  }

  // ---- cockpit: activity ----
  // `since` resets only when the label CHANGES, so a re-announced identical
  // status keeps its elapsed time. The label holds through text streaming
  // until turn_end, exactly as the in-session indicator does.
  if (msg.type === "status") {
    const label = msg.state === "tool" ? (msg.label ?? "tool") : "thinking";
    if (next.activity?.label !== label) next.activity = { label, since: now };
  } else if (msg.type === "bang_start") {
    // First line only, capped — a pasted script must not bloat snapshots.
    next.activity = { label: `! ${msg.command.split("\n", 1)[0].slice(0, 80)}`, since: now };
  } else if (next.status === "idle") {
    next.activity = undefined;
  }

  // ---- cockpit: the pending-ask mirror ----
  if (msg.type === "permission_request") {
    // The FULL detail — never truncated. Grid allow/deny is a real approval
    // decision, so the fleet approver must see exactly what the in-session
    // bar shows; a capped detail could hide a dangerous tail past a benign
    // head. The detail already reached every viewport in the original
    // permission_request; copying it whole here leaks nothing new.
    next.permissions = [
      ...next.permissions,
      { id: msg.id, tool: msg.tool, detail: msg.detail, askedAt: now },
    ];
    // At-cap eviction keeps the length constant, so the changed-metadata
    // check below stays false and the notify storm is damped too.
    if (next.permissions.length > PERMISSION_MIRROR_CAP) {
      next.permissions = next.permissions.slice(-PERMISSION_MIRROR_CAP);
    }
  } else if (msg.type === "permission_resolved") {
    // The adapter's own resolution word — exact where the clock-aging below
    // is approximate. An answered id is usually already gone
    // (permission_answered); the timeout path is the one only this catches.
    next.permissions = next.permissions.filter((p) => p.id !== msg.id);
    if (next.status === "permission" && next.permissions.length === 0) next.status = "working";
  } else if (msg.type === "turn_end" || msg.type === "error") {
    // The turn that owned these asks ended. A queued next turn may keep the
    // session working, but none of the prior turn's approvals survive into it.
    next.permissions = [];
  } else if (next.status === "idle") {
    next.permissions = [];
  } else if (next.permissions.length) {
    // The adapter auto-denies an unanswered ask at PERMISSION_TIMEOUT_MS with
    // no stream event marking it — age the mirror out on the same clock so
    // the row never advertises an ask that can no longer be answered.
    const cutoff = now - PERMISSION_TIMEOUT_MS;
    next.permissions = next.permissions.filter((p) => p.askedAt > cutoff);
  }
  if (msg.type === "usage") next.usage = foldUsage(next.usage, msg);

  return {
    state: next,
    watchersChanged:
      next.status !== prev.status ||
      next.activity?.label !== prev.activity?.label ||
      next.permissions.length !== prev.permissions.length ||
      msg.type === "usage",
  };
}
