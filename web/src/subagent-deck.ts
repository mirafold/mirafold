// The calm-summary derivation for a subagent deck (PLAN Phase SA.1) — pure,
// so Tier-1 can pin it without a DOM. A "card" is any tool_use that other
// wire records reference as their parentId; the anchor is name-agnostic
// (Claude Code's spawn tool is `Agent` in SDK 0.3.201, was `Task`; OpenCode's
// is `task`), so nothing here reads the tool's name as meaning.

export type SubagentTaskLike = {
  name: string;
  detail?: string;
  input?: Record<string, unknown>;
  output?: string;
  isError?: boolean;
};

export type SubagentChildLike = {
  name: string;
  detail?: string;
  output?: string;
};

export type SubagentSummary = {
  /** The engine-reported agent type, verbatim (input.subagent_type). */
  agentType?: string;
  /** The spawn's own description of the task, verbatim — never composed. */
  description: string;
  state: "running" | "done" | "failed";
  toolCount: number;
  /** While running: the child call currently executing ("Grep -rn foo"). */
  currentAction?: string;
  /** Once done: the first line of the subagent's final report, verbatim. */
  resultLine?: string;
};

const ACTION_DETAIL_MAX = 48;
const RESULT_LINE_MAX = 120;

/** The deck's elapsed readout, or undefined when no honest number exists:
 *  only a RUNNING spawn whose record this client saw arrive LIVE has a
 *  truthful start stamp. A REPLAYED record's stamp is the attach/reload
 *  moment, not the spawn — showing it would tick a false duration
 *  (bughunt 2026-08-14) — and a settled deck's duration was never measured. */
export function deckElapsedSeconds(
  task: { startedAt: number; replayed?: boolean },
  running: boolean,
  now: number,
): number | undefined {
  if (!running || task.replayed) return undefined;
  return Math.max(0, Math.floor((now - task.startedAt) / 1_000));
}

export function subagentSummary(
  task: SubagentTaskLike,
  calls: SubagentChildLike[],
): SubagentSummary {
  const input = task.input ?? {};
  const agentType =
    typeof input["subagent_type"] === "string" && input["subagent_type"]
      ? input["subagent_type"]
      : undefined;
  const description =
    (typeof input["description"] === "string" && input["description"]) ||
    task.detail ||
    task.name;
  const state = task.isError ? "failed" : task.output !== undefined ? "done" : "running";
  let currentAction: string | undefined;
  if (state === "running") {
    // The newest un-answered call is what the subagent is doing right now;
    // between calls (or before the first) it is still working, and the line
    // must say so rather than go blank.
    const active = [...calls].reverse().find((c) => c.output === undefined);
    currentAction = active
      ? active.name +
        (active.detail
          ? " " +
            (active.detail.length > ACTION_DETAIL_MAX
              ? active.detail.slice(0, ACTION_DETAIL_MAX) + "…"
              : active.detail)
          : "")
      : "working…";
  }
  let resultLine: string | undefined;
  if (state === "done" && task.output) {
    const first = task.output.split("\n", 1)[0].trim();
    if (first) {
      resultLine = first.length > RESULT_LINE_MAX ? first.slice(0, RESULT_LINE_MAX) + "…" : first;
    }
  }
  return { agentType, description, state, toolCount: calls.length, currentAction, resultLine };
}
