// The calm-summary derivation for a subagent deck — pure,
// so Tier-1 can pin it without a DOM. A "card" is any tool_use that other
// wire records reference as their parentId, or that the engine reports a
// task lifecycle for (task_update); the anchor is name-agnostic (Claude
// Code's spawn tool is `Agent` in SDK 0.3.201, was `Task`; OpenCode's is
// `task`; Codex's is its collab call), so nothing here reads the tool's name
// as meaning.

export type SubagentTaskLike = {
  name: string;
  detail?: string;
  input?: Record<string, unknown>;
  output?: string;
  tail?: string;
  omittedBytes?: number;
  isError?: boolean;
};

export type SubagentChildLike = {
  name: string;
  detail?: string;
  output?: string;
};

/** The engine's own word on the task (task_update), newest wins. `replayed`
 *  marks a state this viewport only knows from replay, never observed live. */
export type TaskLifecycle = {
  state: "running" | "completed" | "failed" | "interrupted" | "unknown";
  label?: string;
  agentType?: string;
  action?: string;
  report?: string;
  reportTail?: string;
  reportOmittedBytes?: number;
  elapsedMs?: number;
  replayed?: boolean;
};

export type SubagentState = "running" | "done" | "failed" | "interrupted" | "unknown";

export type SubagentSummary = {
  /** The engine-reported agent type, verbatim (input.subagent_type). */
  agentType?: string;
  /** The spawn's own description of the task, verbatim — never composed. */
  description: string;
  state: SubagentState;
  /** True when `state` is the ENGINE's lifecycle word, not an inference from
   *  the spawn call's settlement (older daemons, engines without a lane). */
  reported: boolean;
  toolCount: number;
  /** While running: the child call currently executing ("Grep -rn foo"). */
  currentAction?: string;
  /** Once done: the first line of the subagent's final report, verbatim. */
  resultLine?: string;
  /** The retained report, complete as the wire kept it, for the expansion. */
  report?: { text: string; tail?: string; omittedBytes?: number };
  /** The engine's own measured duration, when it reported one. */
  elapsedMs?: number;
};

const ACTION_DETAIL_MAX = 48;
const RESULT_LINE_MAX = 120;

/** The deck's elapsed readout, or undefined when no honest number exists:
 *  only a RUNNING spawn whose record this client saw arrive LIVE has a
 *  truthful start stamp. A REPLAYED record's stamp is the attach/reload
 *  moment, not the spawn — showing it would tick a false duration — and a
 *  settled deck's duration was never measured. */
export function deckElapsedSeconds(
  task: { startedAt: number; replayed?: boolean },
  running: boolean,
  now: number,
): number | undefined {
  if (!running || task.replayed) return undefined;
  return Math.max(0, Math.floor((now - task.startedAt) / 1_000));
}

function firstLine(text: string): string | undefined {
  const first = text.split("\n", 1)[0].trim();
  if (!first) return undefined;
  return first.length > RESULT_LINE_MAX ? first.slice(0, RESULT_LINE_MAX) + "…" : first;
}

export function subagentSummary(
  task: SubagentTaskLike,
  calls: SubagentChildLike[],
  lifecycle?: TaskLifecycle,
): SubagentSummary {
  const input = task.input ?? {};
  const agentType =
    lifecycle?.agentType ||
    (typeof input["subagent_type"] === "string" && input["subagent_type"]
      ? input["subagent_type"]
      : undefined);
  const description =
    lifecycle?.label ||
    (typeof input["description"] === "string" && input["description"]) ||
    task.detail ||
    task.name;
  // The engine's lifecycle word wins outright: a finished spawn, wait, or
  // poll call is not the child finishing. Without one, the call's own
  // settlement is the only evidence there is — and it is marked as such.
  const reported = lifecycle !== undefined;
  const state: SubagentState = lifecycle
    ? lifecycle.state === "completed"
      ? "done"
      : lifecycle.state
    : task.isError
      ? "failed"
      : task.output !== undefined
        ? "done"
        : "running";
  let currentAction: string | undefined;
  if (state === "running") {
    // The newest un-answered call is what the subagent is doing right now;
    // between calls (or before the first) the engine's own action word, if
    // it gave one, else the line still says it is working rather than go blank.
    const active = [...calls].reverse().find((c) => c.output === undefined);
    currentAction = active
      ? active.name +
        (active.detail
          ? " " +
            (active.detail.length > ACTION_DETAIL_MAX
              ? active.detail.slice(0, ACTION_DETAIL_MAX) + "…"
              : active.detail)
          : "")
      : lifecycle?.action
        ? lifecycle.action.length > ACTION_DETAIL_MAX
          ? lifecycle.action.slice(0, ACTION_DETAIL_MAX) + "…"
          : lifecycle.action
        : "working…";
  }
  // The report: the engine's own (task_update.report) first, else the spawn
  // call's result — both retained whole as the wire kept them.
  const report = lifecycle?.report
    ? {
        text: lifecycle.report,
        ...(lifecycle.reportTail !== undefined ? { tail: lifecycle.reportTail } : {}),
        ...(lifecycle.reportOmittedBytes !== undefined ? { omittedBytes: lifecycle.reportOmittedBytes } : {}),
      }
    : task.output
      ? {
          text: task.output,
          ...(task.tail !== undefined ? { tail: task.tail } : {}),
          ...(task.omittedBytes !== undefined ? { omittedBytes: task.omittedBytes } : {}),
        }
      : undefined;
  const resultLine = state !== "running" && report ? firstLine(report.text) : undefined;
  return {
    agentType,
    description,
    state,
    reported,
    toolCount: calls.length,
    currentAction,
    resultLine,
    ...(report ? { report } : {}),
    ...(lifecycle?.elapsedMs !== undefined ? { elapsedMs: lifecycle.elapsedMs } : {}),
  };
}
