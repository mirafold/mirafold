import type { ZoneMsg } from "./session-bus";
import type { Activity } from "./components/ActivityLine";
import type { PermAsk } from "./components/PermissionBar";
import { turnResponse } from "./components/Announcer";
import { nextTurnBalance } from "./turn-busy";

/**
 * The turn as the trusted shell sees it, derived entirely from the wire —
 * the busy indicator, the activity label, the pending permission asks, and
 * the prose banked for the turn-end announcement. Pure, so the sequences
 * that broke this in the past (a queued follow-up, an errored turn, a tail
 * resume, an ask answered on another viewport) are table-testable without a
 * DOM or a socket.
 */
export type TurnState = {
  /** A turn is in flight — drives the stop affordance, Esc, and the indicator. */
  busy: boolean;
  /** Unanswered prompts in flight, counted off the wire (turn-busy.ts). */
  openTurns: number;
  /** A terminal error already closed its turn; suppresses the paired
   * turn_end's second decrement and duplicate completion announcement. */
  errorAwaitingTurnEnd: boolean;
  /** The engine's last status frame or announced tool; null = generic "working…". */
  activity: Activity;
  /** Pending permission prompts, oldest first — SHELL-OWNED UI. */
  asks: PermAsk[];
  /** The turn's prose, accumulated so turn_end can announce the response once. */
  turnText: string;
};

export const IDLE_TURN: TurnState = {
  busy: false,
  openTurns: 0,
  errorAwaitingTurnEnd: false,
  activity: null,
  asks: [],
  turnText: "",
};

export type Announcement = { text: string; assertive?: boolean };

export type TurnInput =
  | { kind: "message"; msg: ZoneMsg }
  /** The socket dropped: this viewport can't be mid-turn any more; replay
   *  (or the turn-activity frames) re-derives busy after reconnect. */
  | { kind: "disconnected" }
  /** The user interrupted: everything in flight dies, but the engine sends
   *  one turn_end for all abandoned work, so the counter drops to that one. */
  | { kind: "interrupt" }
  /** An ask answered HERE — gone immediately; the wire's permission_resolved
   *  then no-ops and stays quiet. */
  | { kind: "answered"; id: string };

const isActivity = (m: ZoneMsg): m is Extract<ZoneMsg, { type: "status" | "thinking_delta" | "text_delta" | "tool_use" }> =>
  m.type === "status" || m.type === "thinking_delta" || m.type === "text_delta" || m.type === "tool_use";

/** Field-wise equality, so a no-op message returns `prev` ITSELF and React's
 *  setState bails out. Every session frame — including the ones this
 *  reducer ignores (render, bang_output, fs_dir…) — otherwise minted a fresh
 *  object and re-rendered the whole Shell, the OutputZone's full row map
 *  included: CPU per frame × transcript length, at a rate the engine
 *  controls (2026-08-26). */
const sameTurnState = (a: TurnState, b: TurnState): boolean =>
  a.busy === b.busy &&
  a.openTurns === b.openTurns &&
  a.errorAwaitingTurnEnd === b.errorAwaitingTurnEnd &&
  a.turnText === b.turnText &&
  a.asks === b.asks &&
  (a.activity === b.activity ||
    (a.activity !== null &&
      b.activity !== null &&
      a.activity.state === b.activity.state &&
      a.activity.label === b.activity.label));

export function reduceTurn(
  prev: TurnState,
  input: TurnInput,
): { state: TurnState; announcements: Announcement[] } {
  const r = reduceTurnFresh(prev, input);
  return sameTurnState(prev, r.state) ? { state: prev, announcements: r.announcements } : r;
}

function reduceTurnFresh(
  prev: TurnState,
  input: TurnInput,
): { state: TurnState; announcements: Announcement[] } {
  const announcements: Announcement[] = [];
  if (input.kind === "disconnected") {
    return {
      state: {
        ...prev,
        openTurns: 0,
        errorAwaitingTurnEnd: false,
        busy: false,
        activity: null,
      },
      announcements,
    };
  }
  if (input.kind === "interrupt") {
    return {
      state: {
        ...prev,
        openTurns: Math.min(prev.openTurns, 1),
        errorAwaitingTurnEnd: false,
      },
      announcements,
    };
  }
  if (input.kind === "answered") {
    return { state: { ...prev, asks: prev.asks.filter((a) => a.id !== input.id) }, announcements };
  }
  const m = input.msg;
  // Replayed history must repaint state but never re-fire live-only side
  // effects: otherwise every reload/reconnect's full-buffer replay would
  // re-speak each historical turn to screen readers, ending with an old
  // response presented as though it just arrived.
  const live = !("replay" in m && m.replay);
  const errorIsTerminal = m.type !== "error" || m.terminal !== false;
  const balance = nextTurnBalance(
    {
      openTurns: prev.openTurns,
      errorAwaitingTurnEnd: prev.errorAwaitingTurnEnd,
    },
    m.type,
    !live,
    errorIsTerminal,
  );
  const next: TurnState = {
    ...prev,
    ...balance,
  };
  if (m.type === "user_prompt") {
    next.busy = true;
    next.activity = { state: "thinking" };
    next.turnText = "";
    if (live) announcements.push({ text: "Sent. Working…" });
  } else if (isActivity(m)) {
    // Busy re-derives from ANY turn activity, not just the user_prompt — a
    // tail resume mid-turn replays none of the turn's opening frames, and
    // busy was cleared on the disconnect.
    next.busy = true;
    // A SUBAGENT's traffic (parentId set) still proves the turn is busy, but
    // it is not the parent's voice — child prose and child tool churn must
    // not steer the activity label (the deck shows each subagent's own
    // action), and child prose never lands in the turn-end announcement.
    // The announcer still speaks child tools — the audible peer of the
    // deck's ticker.
    const subagentTraffic = m.type !== "status" && Boolean(m.parentId);
    if (m.type === "status") next.activity = { state: m.state, label: m.label };
    else if (m.type === "thinking_delta") {
      if (!subagentTraffic) next.activity = { state: "thinking" };
    } else if (m.type === "tool_use") {
      if (!subagentTraffic) next.activity = { state: "tool", label: m.name };
    } else if (!subagentTraffic) {
      // Streamed prose means the last specific label is over; the indicator
      // falls back to the generic "working…".
      next.activity = null;
    }
    if (m.type === "text_delta" && !subagentTraffic) next.turnText = prev.turnText + m.text;
    if (m.type === "tool_use" && live) announcements.push({ text: `Running ${m.name}.` });
  } else if (m.type === "tool_result") {
    // A finished tool must not keep naming itself — a frozen "Bash" through
    // the next model round trip reads as "done?". A CHILD's result is not
    // the labeled tool finishing.
    if (!m.parentId && prev.activity?.state === "tool") next.activity = null;
  } else if (m.type === "turn_end") {
    next.busy = next.openTurns > 0;
    next.activity = null;
    next.asks = []; // a request that outlived its turn is void (server denies)
    if (live && !prev.errorAwaitingTurnEnd) {
      announcements.push({ text: turnResponse(prev.turnText) });
    }
    next.turnText = "";
  } else if (m.type === "permission_request") {
    next.asks = [
      ...prev.asks,
      { tool: m.tool, detail: m.detail, id: m.id, ...(m.parentId ? { parentId: m.parentId } : {}) },
    ];
    // Assertive: this one blocks the turn until answered. A replayed ask
    // still paints the bar (it may be genuinely pending), just without
    // re-interrupting the reader.
    if (live) {
      announcements.push({
        text: `Permission needed${m.parentId ? " (subagent)" : ""}: ${m.tool}. ${m.detail}`,
        assertive: true,
      });
    }
  } else if (m.type === "permission_resolved") {
    // Answered on ANOTHER viewport, or auto-denied by the daemon's timeout —
    // drop it HERE too. A locally-answered ask is already gone, so the
    // filter no-ops and the announcement stays quiet.
    if (live && prev.asks.some((a) => a.id === m.id)) {
      announcements.push({ text: m.allow ? "Permission allowed." : "Permission denied." });
    }
    next.asks = prev.asks.filter((a) => a.id !== m.id);
  } else if (m.type === "error") {
    if (m.terminal !== false) {
      next.busy = next.openTurns > 0;
      next.activity = null;
      next.asks = [];
      next.turnText = "";
    }
    if (live) announcements.push({ text: m.message, assertive: true });
  } else if (m.type === "zone_reset") {
    return { state: { ...IDLE_TURN }, announcements };
  }
  return { state: next, announcements };
}
