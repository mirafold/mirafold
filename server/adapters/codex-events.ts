import { randomUUID } from "node:crypto";
import type { SessionMsg } from "../protocol";
import { type TodoItem, capOutput, joinTextBlocks } from "./types";
import { MIRAFOLD_MCP, generativeUIMsg, renderIdFor } from "./render-mcp-cmd";
import { ChecklistPainter } from "./wire-helpers";
import { convertMermaidCharts } from "./mermaid-chart";

// The `codex app-server` v2 notification stream (`item/*`, `turn/*`,
// `thread/*`) normalized into SessionMsg. Shapes come from the binary's own
// schema (`codex app-server generate-json-schema`); the CA.1 spike in
// codex.spike.md records what was observed live.

type Emit = (message: SessionMsg) => void;
type ItemPhase = "started" | "completed";

/** One `ThreadItem` as it arrives — the fields the mapper reads, loosely
 *  typed on purpose: engine data is checked at use, never trusted by shape. */
export type CodexItem = {
  type: string;
  id: string;
  text?: string;
  summary?: unknown;
  command?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  status?: string;
  changes?: unknown;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown; structuredContent?: unknown } | null;
  error?: { message?: string } | null;
  query?: string;
};

export type CodexMcpToolCall = Pick<CodexItem, "result" | "arguments">;

export function mcpText(content: unknown): string {
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return joinTextBlocks(content);
}

// The component id the render-mcp stub assigned — the shared precedence in
// render-mcp-cmd.ts, fed Codex's three channels.
export function extractRenderId(item: CodexMcpToolCall): string {
  return renderIdFor({
    structured: item.result?.structuredContent,
    ackText: mcpText(item.result?.content),
    argId: (item.arguments as { id?: unknown } | undefined)?.id,
  });
}

type TokenTotals = { inputTokens: number; outputTokens: number; reasoningOutputTokens: number };

const asTotals = (value: unknown): TokenTotals | undefined => {
  const t = value as Partial<TokenTotals> | undefined;
  if (!t || typeof t.inputTokens !== "number" || typeof t.outputTokens !== "number") return undefined;
  return {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    reasoningOutputTokens: typeof t.reasoningOutputTokens === "number" ? t.reasoningOutputTokens : 0,
  };
};

/** The engine's fatal-turn shape (`TurnError`), read defensively. */
export const turnErrorMessage = (error: unknown): string | undefined => {
  const e = error as { message?: unknown; additionalDetails?: unknown } | null | undefined;
  if (!e || typeof e.message !== "string") return undefined;
  return typeof e.additionalDetails === "string" && e.additionalDetails
    ? `${e.message} (${e.additionalDetails})`
    : e.message;
};

export class CodexEventMapper {
  private announced = new Set<string>();
  private readonly checklist: ChecklistPainter;
  // Streaming prose per agentMessage item: how much of it already went out
  // as deltas, whether we are holding the rest for the item to finish, and a
  // one/two-backtick suffix that may be the start of a split code fence.
  private prose = new Map<string, { streamed: number; holding: boolean; pending: string }>();
  private thinkingStreamed = new Set<string>();
  private thinkingAnnounced = false;
  private totals?: TokenTotals;
  private turnBaseline?: TokenTotals;
  // Σ of the event's per-response `last` over this turn — the preferred
  // figure. `total` is the THREAD's cumulative count and survives a
  // `thread/resume` (the rollout persists it), so a mapper born after a
  // daemon restart has no baseline for it: total − 0 on the first turn
  // would re-report every pre-restart token, on top of the checkpointed
  // usage the registry already restored (review 2026-08-29).
  private turnLast?: TokenTotals;

  constructor(
    private readonly options: {
      emit: Emit;
      workspaceDir: string;
      modelName: () => string | undefined;
      providerDiagnostic: (value: unknown) => string;
    },
  ) {
    this.checklist = new ChecklistPainter(options.emit);
  }

  /** A turn is starting: usage is measured from here, paintings re-anchor. */
  beginTurn() {
    this.turnBaseline = this.totals;
    this.turnLast = undefined;
    this.thinkingAnnounced = false;
  }

  /** The turn ended (any status): emit its usage once, then reset. */
  endTurn() {
    const turn = this.turnLast ?? this.turnDelta();
    if (turn) {
      const inputTokens = turn.inputTokens;
      const outputTokens = turn.outputTokens + turn.reasoningOutputTokens;
      if (inputTokens > 0 || outputTokens > 0) {
        this.options.emit({
          type: "usage",
          model: this.options.modelName(),
          inputTokens: Math.max(0, inputTokens),
          outputTokens: Math.max(0, outputTokens),
        });
      }
    }
    this.turnBaseline = this.totals;
    this.turnLast = undefined;
    this.checklist.reset();
    this.prose.clear();
    this.thinkingStreamed.clear();
    this.announced.clear();
  }

  /** The fallback when the engine sends no per-response `last`: this turn's
   *  movement of the thread total. */
  private turnDelta(): TokenTotals | undefined {
    if (!this.totals) return undefined;
    const base = this.turnBaseline ?? { inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    return {
      inputTokens: this.totals.inputTokens - base.inputTokens,
      outputTokens: this.totals.outputTokens - base.outputTokens,
      reasoningOutputTokens: this.totals.reasoningOutputTokens - base.reasoningOutputTokens,
    };
  }

  /** One notification for the session's thread. `turn/completed` is the
   *  session's to handle (it owns the turn lifecycle); everything else lands
   *  here. */
  handle(method: string, params: unknown) {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "turn/started":
        this.options.emit({ type: "status", state: "thinking" });
        break;
      case "item/started":
        this.onItem(p["item"] as CodexItem | undefined, "started");
        break;
      case "item/completed":
        this.onItem(p["item"] as CodexItem | undefined, "completed");
        break;
      case "item/agentMessage/delta":
        this.onProseDelta(String(p["itemId"] ?? ""), String(p["delta"] ?? ""));
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const delta = String(p["delta"] ?? "");
        if (!delta) break;
        this.thinkingStreamed.add(String(p["itemId"] ?? ""));
        this.announceThinking();
        this.options.emit({ type: "thinking_delta", text: delta });
        break;
      }
      case "turn/plan/updated":
        this.emitChecklist(Array.isArray(p["plan"]) ? (p["plan"] as unknown[]) : []);
        break;
      case "thread/tokenUsage/updated": {
        const usage = p["tokenUsage"] as { total?: unknown; last?: unknown } | undefined;
        const total = asTotals(usage?.total);
        if (total) this.totals = total;
        const last = asTotals(usage?.last);
        if (last) {
          const sum = this.turnLast ?? { inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
          this.turnLast = {
            inputTokens: sum.inputTokens + last.inputTokens,
            outputTokens: sum.outputTokens + last.outputTokens,
            reasoningOutputTokens: sum.reasoningOutputTokens + last.reasoningOutputTokens,
          };
        }
        break;
      }
      case "error": {
        // Non-fatal here: a fatal error ends the turn through `turn/completed`
        // (status failed + the same error), which the session reports once.
        const message = turnErrorMessage(p["error"]);
        if (message && p["willRetry"] === true) {
          this.options.emit({
            type: "notice",
            text: `${this.options.providerDiagnostic(message)} — retrying`,
            kind: "retry",
            source: "codex",
          });
        }
        break;
      }
      case "warning":
        if (typeof p["message"] === "string" && p["message"]) {
          this.options.emit({
            type: "notice",
            text: this.options.providerDiagnostic(p["message"]),
            kind: "warning",
            source: "codex",
          });
        }
        break;
    }
  }

  private announceThinking() {
    if (this.thinkingAnnounced) return;
    this.thinkingAnnounced = true;
    this.options.emit({ type: "status", state: "thinking" });
  }

  /** Prose streams as it arrives — until a code fence opens. From there the
   *  rest of the message is held for completion, so a hand-written mermaid
   *  chart can still become the real chart component (the whole reason the
   *  completed text is re-read). Plain prose never waits. */
  private onProseDelta(itemId: string, delta: string) {
    if (!delta) return;
    const state = this.prose.get(itemId) ?? { streamed: 0, holding: false, pending: "" };
    this.prose.set(itemId, state);
    if (state.holding) return;
    const combined = state.pending + delta;
    state.pending = "";
    const fenceAt = combined.indexOf("```");
    if (fenceAt >= 0) {
      const prefix = combined.slice(0, fenceAt);
      if (prefix) {
        state.streamed += prefix.length;
        this.options.emit({ type: "text_delta", text: prefix });
      }
      state.holding = true;
      return;
    }
    const pendingLength = combined.endsWith("``") ? 2 : combined.endsWith("`") ? 1 : 0;
    const ready = pendingLength ? combined.slice(0, -pendingLength) : combined;
    state.pending = pendingLength ? combined.slice(-pendingLength) : "";
    if (!ready) return;
    state.streamed += ready.length;
    this.options.emit({ type: "text_delta", text: ready });
  }

  /** Normalize one thread item. `phase` distinguishes start vs. finish. */
  private onItem(item: CodexItem | undefined, phase: ItemPhase) {
    if (!item || typeof item.type !== "string" || typeof item.id !== "string") return;
    switch (item.type) {
      case "agentMessage":
        this.onAgentMessage(item, phase);
        break;
      case "reasoning":
        this.onReasoning(item, phase);
        break;
      case "commandExecution":
        this.onCommandExecution(item, phase);
        break;
      case "fileChange":
        this.onFileChange(item, phase);
        break;
      case "mcpToolCall":
        this.onMcpToolCall(item, phase);
        break;
      case "webSearch":
        this.onWebSearch(item, phase);
        break;
      case "contextCompaction":
        this.onContextCompaction(phase);
        break;
    }
  }

  private onAgentMessage(item: CodexItem, phase: ItemPhase) {
    if (phase !== "completed") return;
    const text = typeof item.text === "string" ? item.text : "";
    const streamed = this.prose.get(item.id)?.streamed ?? 0;
    this.prose.delete(item.id);
    const rest = text.slice(streamed);
    if (!rest) return;
    // Any mermaid xychart the model still hand-wrote becomes the real chart
    // component; all other text passes through verbatim.
    for (const segment of convertMermaidCharts(rest)) {
      if ("text" in segment) {
        this.options.emit({ type: "text_delta", text: segment.text });
      } else {
        this.options.emit({
          type: "render",
          component: "chart",
          props: segment.chart as unknown as Record<string, unknown>,
          id: randomUUID(),
        });
      }
    }
  }

  private onReasoning(item: CodexItem, phase: ItemPhase) {
    if (phase === "started") {
      this.announceThinking();
    } else if (!this.thinkingStreamed.has(item.id)) {
      // No deltas came for this item: the summary arrives whole.
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((s): s is string => typeof s === "string").join("\n")
        : "";
      if (summary) {
        this.announceThinking();
        this.options.emit({ type: "thinking_delta", text: summary });
      }
    }
    if (phase === "completed") this.thinkingStreamed.delete(item.id);
  }

  private onCommandExecution(item: CodexItem, phase: ItemPhase) {
    const command = typeof item.command === "string" ? item.command : "";
    if (phase === "started") {
      this.announceTool(item.id, "Shell", command, { command });
      return;
    }
    this.ensureAnnounced(item.id, "Shell", command, { command });
    const capped = capOutput(item.aggregatedOutput ?? "");
    // A command that RAN is an ordinary completed command, exactly as the
    // Codex TUI shows it — dim, foldable, exit code annotated — never a red
    // error, whatever its exit status. app-server marks ANY nonzero exit
    // `status: "failed"` (grep-no-match, a `gh repo view` on a missing repo,
    // a failing test — measured 2026-08-25), unlike the old exec path which
    // called those "completed"; keying error-ness off `status` alone turned
    // every such probe into an expanded error block that broke the fold.
    // So: it ran iff it produced an exit code. Only a command that couldn't
    // run at all (no exit code) or was declined is an error.
    const declined = item.status === "declined";
    const ran = item.exitCode != null;
    const isError = declined || (!ran && item.status === "failed");
    const exitNote =
      ran && item.exitCode !== 0 ? `${capped.text ? "\n" : ""}(exit ${item.exitCode})` : "";
    this.finishTool(item.id, {
      output: declined
        ? `${capped.text}${capped.text ? "\n" : ""}(declined)`
        : capped.text + exitNote,
      truncatedBytes: capped.truncatedBytes,
      isError,
    });
  }

  private onFileChange(item: CodexItem, phase: ItemPhase) {
    if (phase !== "completed") return;
    const changes = Array.isArray(item.changes)
      ? (item.changes as { kind?: unknown; path?: unknown }[])
      : [];
    const paths = changes
      .map((change) => `${String(change.kind ?? "update")} ${String(change.path ?? "")}`.trim())
      .join(", ");
    this.announceTool(item.id, "apply_patch", paths, { changes });
    const declined = item.status === "declined";
    this.finishTool(item.id, {
      output: declined ? "(declined)" : paths || "(no changes)",
      isError: item.status === "failed" || declined,
    });
  }

  private onMcpToolCall(item: CodexItem, phase: ItemPhase) {
    const server = typeof item.server === "string" ? item.server : "";
    const tool = typeof item.tool === "string" ? item.tool : "";
    // Mirafold's generative-UI server becomes the render/artifact message
    // represented by the call rather than a raw tool row.
    if (server === MIRAFOLD_MCP) {
      if (phase === "completed" && item.status !== "failed" && !item.error) {
        this.emitGenerativeUI(tool, item);
      }
      return;
    }
    const label = `${server}.${tool}`;
    if (phase === "started") {
      this.announceTool(item.id, label, tool, item.arguments);
      return;
    }
    this.ensureAnnounced(item.id, label, tool, item.arguments);
    const capped = capOutput(
      item.error ? String(item.error.message ?? "") : mcpText(item.result?.content),
    );
    this.finishTool(item.id, {
      output: capped.text,
      truncatedBytes: capped.truncatedBytes,
      isError: item.status === "failed" || Boolean(item.error),
    });
  }

  private onWebSearch(item: CodexItem, phase: ItemPhase) {
    if (phase !== "completed") return;
    const query = typeof item.query === "string" ? item.query : "";
    this.announceTool(item.id, "web_search", query, { query });
    this.finishTool(item.id, { output: "(results returned to the agent)" });
  }

  private onContextCompaction(phase: ItemPhase) {
    if (phase !== "completed") return;
    this.options.emit({
      type: "notice",
      text: "Codex compacted the conversation context.",
      kind: "compaction",
    });
  }

  /** Announce only when the started phase was missed. */
  private ensureAnnounced(id: string, name: string, detail: string, input: unknown) {
    if (!this.announced.has(id)) this.announceTool(id, name, detail, input);
  }

  private announceTool(id: string, name: string, detail: string, input: unknown) {
    this.announced.add(id);
    this.options.emit({ type: "status", state: "tool", label: name });
    this.options.emit({
      type: "tool_use",
      name,
      detail: detail || undefined,
      id,
      input: typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined,
    });
  }

  private finishTool(
    id: string,
    result: { output: string; isError?: boolean; truncatedBytes?: number },
  ) {
    this.announced.delete(id);
    this.options.emit({ type: "tool_result", ...result, id });
  }

  private emitGenerativeUI(tool: string, item: CodexItem) {
    const args =
      item.arguments && typeof item.arguments === "object"
        ? (item.arguments as Record<string, unknown>)
        : {};
    const message = generativeUIMsg(tool, args, extractRenderId(item), this.options.workspaceDir);
    if (message) this.options.emit(message);
  }

  private emitChecklist(steps: unknown[]) {
    const todos: TodoItem[] = steps.flatMap((raw) => {
      const step = raw as { step?: unknown; status?: unknown };
      if (typeof step.step !== "string" || !step.step) return [];
      const status: TodoItem["status"] =
        step.status === "completed" ? "completed" : step.status === "inProgress" ? "in_progress" : "pending";
      return [{ content: step.step, status }];
    });
    this.checklist.paint(todos);
  }
}
