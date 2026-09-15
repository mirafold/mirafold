import { createHash, randomUUID } from "node:crypto";
import type { SessionMsg, ToolAction } from "../../protocol";
import { type TodoItem, capOutput, joinTextBlocks, outputFields, OUTPUT_CAP_BYTES, SubagentProseBudget } from "../types";
import { LiveOutput } from "../live-output";
import { resolveImageProps } from "../../render-image";
import { MIRAFOLD_MCP, generativeUIMsg, renderIdFor } from "../render-mcp-cmd";
import { ChecklistPainter, UnknownKindReporter, displayPath, inertToken } from "../wire-helpers";
import { CODEX_IGNORED_ITEMS, CODEX_IGNORED_METHODS } from "./codex-ledger";
import { describePatchChange, normalizePatchChanges } from "./codex-patch";
import { createLogger } from "../../log";
import { convertMermaidCharts } from "./mermaid-chart";

const log = createLogger("codex-events");

export { STREAM_CAP_MARKER, streamCapMarker } from "../live-output";

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
  phase?: unknown;
  summary?: unknown;
  command?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  commandActions?: unknown;
  processId?: string | null;
  status?: string;
  changes?: unknown;
  // collabAgentToolCall / subAgentActivity / imageView / imageGeneration /
  // dynamicToolCall / sleep (TS.9–TS.10)
  prompt?: unknown;
  receiverThreadIds?: unknown;
  agentsStates?: unknown;
  agentThreadId?: unknown;
  agentPath?: unknown;
  kind?: unknown;
  path?: unknown;
  savedPath?: unknown;
  revisedPrompt?: unknown;
  namespace?: unknown;
  contentItems?: unknown;
  success?: unknown;
  durationMs?: unknown;
  failure?: unknown;
  model?: unknown;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown; structuredContent?: unknown } | null;
  error?: { message?: string } | null;
  query?: string;
};

export type CodexMcpToolCall = Pick<CodexItem, "result" | "arguments">;

function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

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
  // agentMessage.phase per item id, learned at item/started (verified live
  // 2026-08-30: started carries it), so every delta is tagged as it streams.
  private phaseOf = new Map<string, "commentary" | "final">();
  // Subagent lane (TS.9): the collab call that first named a child thread is
  // its anchor row; the child's activity groups under it via parentId.
  private subagentAnchor = new Map<string, string>();
  // Anchors persist across turns so a long-running child keeps grouping, so
  // the map is bounded here instead: past the cap a new thread's activity
  // falls to the budgeted unanchored lane rather than growing memory.
  private static readonly MAX_SUBAGENT_ANCHORS = 5_000;
  // Child state updates forwarded from ONE collab result: a fan-out past
  // this is engine-sized noise, not a transcript (round 4).
  static readonly MAX_TASK_UPDATES_PER_RESULT = 500;
  // Streamed tool output (TS.11 / Phase TF): the shared bounded accumulator
  // — legacy prefix deltas plus replacement snapshots, capped like the final
  // output so a chatty command cannot flood the ring.
  private readonly live: LiveOutput;
  // Latest normalized fileChange snapshot per running item. Codex publishes
  // full structured snapshots, not textual patch deltas; the signature keeps
  // duplicate completion snapshots from repainting the same row.
  private fileChangeSnapshots = new Map<string, string>();
  // Subagent activity lines ride the wire as parented narration, so they get
  // the same per-subagent byte budget as the other engines' lanes
  // (SECURITY.md: a looping engine cannot grow the wire without bound).
  private subagentProse = new SubagentProseBudget();
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
      /** Live-output ceiling per running item; tests set it, production inherits the env cap. */
      outputCapBytes?: number;
      /** Unit-test seam for the child-item flood cap; production uses MAX_CHILD_ITEMS. */
      maxChildItems?: number;
    },
  ) {
    this.checklist = new ChecklistPainter(options.emit);
    this.unknown = new UnknownKindReporter(options.emit, "Codex", (message) => log.warn(message));
    this.live = new LiveOutput({ emit: options.emit, capBytes: options.outputCapBytes });
    this.maxChildItems = Math.max(0, options.maxChildItems ?? CodexEventMapper.MAX_CHILD_ITEMS);
  }

  private readonly unknown: UnknownKindReporter;

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
    this.fileChangeSnapshots.clear();
    this.subagentProse.clear();
    // A child announced this turn may outlive it (a spawn with no wait): its
    // bookkeeping survives until the engine's terminal word on that thread,
    // so its later items still ride the lane instead of surfacing as root
    // output or re-announcing themselves (PR #122 review). Everything of a
    // thread that already settled goes now; root-level state resets as before.
    for (const thread of [...this.childThreadItems.keys()]) if (!this.runningChildren.has(thread)) this.forgetChildThread(thread);
    for (const id of [...this.prose.keys()]) if (!this.childItems.has(id)) this.prose.delete(id);
    for (const id of [...this.phaseOf.keys()]) if (!this.childItems.has(id)) this.phaseOf.delete(id);
    for (const id of [...this.thinkingStreamed]) if (!this.childItems.has(id)) this.thinkingStreamed.delete(id);
    for (const id of [...this.announced]) if (!this.childItems.has(id)) this.announced.delete(id);
    this.live.clear({ keepChildren: true });
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
      case "item/commandExecution/outputDelta":
        this.streamToolOutput(String(p["itemId"] ?? ""), String(p["delta"] ?? ""));
        break;
      // Retained for version skew. Current Codex marks this notification
      // deprecated and no longer emits it; patchUpdated below is authoritative.
      case "item/fileChange/outputDelta":
        this.streamToolOutput(String(p["itemId"] ?? ""), String(p["delta"] ?? ""));
        break;
      case "item/fileChange/patchUpdated":
        this.publishFileChange(String(p["itemId"] ?? ""), p["changes"]);
        break;
      case "item/mcpToolCall/progress":
        this.onMcpProgress(String(p["itemId"] ?? ""), p["message"]);
        break;
      case "item/commandExecution/terminalInteraction":
        this.onTerminalInteraction(String(p["itemId"] ?? ""), p["stdin"]);
        break;
      case "item/plan/delta": {
        // The model's written plan streams like prose and is narration by
        // nature — never the answer.
        const itemId = String(p["itemId"] ?? "");
        this.phaseOf.set(itemId, "commentary");
        this.onProseDelta(itemId, String(p["delta"] ?? ""));
        break;
      }
      case "deprecationNotice":
      case "configWarning":
      case "guardianWarning":
        if (typeof p["message"] === "string" && p["message"]) {
          this.options.emit({ type: "notice", text: this.options.providerDiagnostic(p["message"]), kind: "warning", source: "codex" });
        }
        break;
      case "mcpServer/startupStatus/updated":
        // User-configured MCP servers remain Codex's administration. The one
        // server Mirafold itself injects is different: without it the model
        // cannot honor the render guidance, so surface Codex's exact startup
        // diagnostic instead of leaving the user with missing tools.
        if (
          p["name"] === MIRAFOLD_MCP &&
          p["status"] === "failed"
        ) {
          const detail =
            typeof p["error"] === "string" && p["error"]
              ? this.options.providerDiagnostic(p["error"])
              : "Codex reported no diagnostic.";
          this.options.emit({
            type: "notice",
            text:
              "Mirafold render tools failed to start: " +
              inertToken(detail, 500),
            kind: "warning",
            source: "codex",
          });
        }
        break;
      case "model/rerouted": {
        const to = typeof p["toModel"] === "string" ? p["toModel"] : typeof p["model"] === "string" ? p["model"] : "";
        const from = typeof p["fromModel"] === "string" ? p["fromModel"] : "";
        this.options.emit({
          type: "notice",
          text: `Codex rerouted the model${from ? ` from ${inertToken(from)}` : ""}${to ? ` to ${inertToken(to)}` : ""}.`,
          kind: "info",
        });
        break;
      }
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
      default:
        if (!(method in CODEX_IGNORED_METHODS)) this.unknown.report("event", method);
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
        this.emitProse(itemId, prefix);
      }
      state.holding = true;
      return;
    }
    const pendingLength = combined.endsWith("``") ? 2 : combined.endsWith("`") ? 1 : 0;
    const ready = pendingLength ? combined.slice(0, -pendingLength) : combined;
    state.pending = pendingLength ? combined.slice(-pendingLength) : "";
    if (!ready) return;
    state.streamed += ready.length;
    this.emitProse(itemId, ready);
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
      case "plan":
        // A completed plan item carries the whole text; deltas may have
        // streamed part of it already (same remainder rule as prose).
        this.phaseOf.set(item.id, "commentary");
        this.onAgentMessage(item, phase);
        break;
      case "collabAgentToolCall":
        this.onCollabCall(item, phase);
        break;
      case "subAgentActivity":
        if (phase === "completed") this.onSubagentActivity(item);
        break;
      case "imageView":
        if (phase === "completed") this.onImageView(item);
        break;
      case "imageGeneration":
        if (phase === "completed") this.onImageGeneration(item);
        break;
      case "dynamicToolCall":
        this.onDynamicToolCall(item, phase);
        break;
      case "sleep":
        if (phase === "completed") this.onSleep(item);
        break;
      case "enteredReviewMode":
        if (phase === "completed") this.options.emit({ type: "notice", text: "Codex entered review mode.", kind: "info" });
        break;
      case "exitedReviewMode":
        if (phase === "completed") this.options.emit({ type: "notice", text: "Codex left review mode.", kind: "info" });
        break;
      default:
        if (phase === "completed" && !(item.type in CODEX_IGNORED_ITEMS)) this.unknown.report("item", item.type);
    }
  }

  private emitProse(itemId: string, text: string) {
    const message = this.proseMsg(itemId, text);
    if (message) this.options.emit(message);
  }

  private proseMsg(itemId: string, text: string): SessionMsg | null {
    const phase = this.phaseOf.get(itemId);
    const parentId = this.childItems.get(itemId);
    if (parentId) {
      // A child's prose rides its deck's lane, budget-capped like every
      // other engine's subagent lane; past the budget nothing rides the wire
      // (an empty delta would still be a wire and replay record).
      const forwarded = this.subagentProse.take(parentId, text);
      if (!forwarded) return null;
      return { type: "text_delta", text: forwarded, parentId, ...(phase ? { phase } : {}) };
    }
    return phase ? { type: "text_delta", text, phase } : { type: "text_delta", text };
  }

  private onAgentMessage(item: CodexItem, phase: ItemPhase) {
    const declared = item.phase === "commentary" ? "commentary" : item.phase === "final_answer" ? "final" : undefined;
    if (declared) this.phaseOf.set(item.id, declared);
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
        this.emitProse(item.id, segment.text);
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
    const parentId = this.childItems.get(item.id);
    if (phase === "started") {
      if (!parentId) this.announceThinking(); // a child's reasoning never steers the root activity line
    } else if (!this.thinkingStreamed.has(item.id)) {
      // No deltas came for this item: the summary arrives whole.
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((s): s is string => typeof s === "string").join("\n")
        : "";
      if (summary) {
        if (parentId) {
          const forwarded = this.subagentProse.take(parentId, summary);
          if (forwarded) this.options.emit({ type: "thinking_delta", text: forwarded, parentId });
        } else {
          this.announceThinking();
          this.options.emit({ type: "thinking_delta", text: summary });
        }
      }
    }
    if (phase === "completed") this.thinkingStreamed.delete(item.id);
  }

  private onCommandExecution(item: CodexItem, phase: ItemPhase) {
    const command = typeof item.command === "string" ? item.command : "";
    const actions = commandActions(item.commandActions);
    if (phase === "started") {
      this.announceTool(item.id, "Shell", command, { command }, actions);
      return;
    }
    this.ensureAnnounced(item.id, "Shell", command, { command }, actions);
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
    // The exit status rides as a fact of its own (Phase TF) — the browser
    // badges "exit N" on the row — and stays in the HEAD text for older
    // clients, which never see a tail: a large failing run must not read as
    // a clean success on a pre-TF viewport (review 2026-09-15).
    const exitNote =
      ran && item.exitCode !== 0 ? `${capped.text ? "\n" : ""}(exit ${item.exitCode})` : "";
    this.finishTool(item.id, {
      ...outputFields(capped),
      output: declined
        ? `${capped.text}${capped.text ? "\n" : ""}(declined)`
        : capped.text + exitNote,
      isError,
      ...(ran ? { exitCode: item.exitCode as number } : {}),
      ...(typeof item.durationMs === "number" && item.durationMs >= 0 ? { durationMs: Math.floor(item.durationMs) } : {}),
    });
  }

  private onFileChange(item: CodexItem, phase: ItemPhase) {
    const summary = this.publishFileChange(item.id, item.changes);
    if (phase === "started") return;
    const declined = item.status === "declined";
    this.finishTool(item.id, {
      output: declined ? "(declined)" : summary || "(no changes)",
      isError: item.status === "failed" || declined,
    });
  }

  /** Paint the latest full patch snapshot onto one stable running row. */
  private publishFileChange(id: string, rawChanges: unknown): string {
    if (!id) return "";
    const changes = normalizePatchChanges(rawChanges, this.options.workspaceDir);
    const summary = changes.map(describePatchChange).join(", ");
    const signature = JSON.stringify(changes);
    if (!this.announced.has(id)) {
      this.fileChangeSnapshots.set(id, signature);
      this.announceTool(id, "apply_patch", summary, { changes });
    } else if (this.fileChangeSnapshots.get(id) !== signature) {
      this.fileChangeSnapshots.set(id, signature);
      this.options.emit({ type: "tool_update", id, detail: summary, input: { changes } });
    }
    return summary;
  }

  /** Streamed bytes of a running command (plus legacy patch output): forwarded only
   *  for a row already announced, through the shared bounded accumulator. */
  private streamToolOutput(itemId: string, delta: string) {
    if (!delta || !this.announced.has(itemId)) return;
    this.live.append(itemId, delta, this.childItems.get(itemId));
  }

  /** The call's own progress line, in the running row's live preview — what
   *  the TUI prints while an MCP tool works (Phase TF2.3). */
  private onMcpProgress(itemId: string, message: unknown) {
    if (typeof message === "string" && message) this.streamToolOutput(itemId, `${inertToken(message, 500)}\n`);
  }

  /** Bytes the AGENT typed into its running command's PTY: shown in the
   *  output stream marked as input, the way an echoing terminal shows them
   *  (Phase TF2.3). `processId` ties it to the same running item. */
  private onTerminalInteraction(itemId: string, raw: unknown) {
    const stdin = typeof raw === "string" ? raw.replace(/\r?\n$/, "") : "";
    if (stdin) this.streamToolOutput(itemId, `‹stdin› ${inertToken(stdin, 500)}\n`);
  }

  /** A collab call (spawn / wait / send…) is a tool row named by the engine's
   *  own tool name; the first call naming a child thread anchors that
   *  thread's later activity (TS.9); the child's own items then arrive on
   *  this connection and ride the lane (verified live 2026-09-15). */
  /** The parts of a collab call every reading shares: the row's name/detail/
   *  input and the per-thread states its result carries. */
  private collabShape(item: CodexItem) {
    const name = typeof item.tool === "string" && item.tool ? inertToken(item.tool, 64) : "collab";
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((t): t is string => typeof t === "string")
      : [];
    const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
    const detail = prompt ? firstLine(prompt, 96) : receivers.join(", ");
    const input = {
      ...(prompt ? { prompt } : {}),
      ...(receivers.length ? { receiverThreadIds: receivers } : {}),
      ...(typeof item.model === "string" ? { model: item.model } : {}),
    };
    const states =
      typeof item.agentsStates === "object" && item.agentsStates !== null
        ? Object.entries(item.agentsStates as Record<string, { status?: unknown; message?: unknown }>)
        : [];
    return { name, receivers, prompt, detail, input, states };
  }

  /** The collab row's result: engine-sized fan-out, built only up to the
   *  output ceiling and saying how many lines were left, instead of
   *  materializing every state first (release review 2026-09-01). */
  private finishCollabCall(item: CodexItem, states: Array<[string, { status?: unknown; message?: unknown }]>) {
    const lines: string[] = [];
    let budget = OUTPUT_CAP_BYTES - 32; // room for the "… N more" line
    for (const [thread, st] of states) {
      const status = typeof st?.status === "string" ? st.status : "?";
      const message = typeof st?.message === "string" && st.message ? ` — ${firstLine(st.message, 160)}` : "";
      const line = `${thread}: ${status}${message}`;
      budget -= Buffer.byteLength(line, "utf8") + 1;
      if (budget < 0) break;
      lines.push(line);
    }
    if (lines.length < states.length) lines.push(`… ${states.length - lines.length} more`);
    const failed = states.some(([, st]) => st?.status === "errored" || st?.status === "notFound");
    // The state fan-out is engine-sized: capped like every other result.
    const capped = capOutput(lines.join("\n"));
    this.finishTool(item.id, {
      ...outputFields(capped),
      output: item.status === "declined" ? "(declined)" : capped.text || "(done)",
      isError: item.status === "failed" || item.status === "declined" || failed,
    });
  }

  private onCollabCall(item: CodexItem, phase: ItemPhase) {
    const { name, receivers, prompt, detail, input, states } = this.collabShape(item);
    for (const thread of receivers) {
      if (!this.subagentAnchor.has(thread) && this.subagentAnchor.size < CodexEventMapper.MAX_SUBAGENT_ANCHORS)
        this.subagentAnchor.set(thread, item.id);
    }
    if (phase === "started") {
      this.announceTool(item.id, name, detail, input);
      // A spawn names its child: the task exists and is running from the
      // engine's point of view before the spawn call itself settles (TF2.4).
      if (item.tool === "spawnAgent" || item.tool === "spawn_agent") {
        for (const thread of receivers) {
          // Labels only for anchored threads: the anchor table is the one
          // bound on fan-out (PR #120 review round 2).
          if (this.subagentAnchor.has(thread)) this.taskLabels.set(thread, firstLine(prompt, 96) || thread);
          this.emitTask(thread, "running");
        }
      }
      return;
    }
    this.ensureAnnounced(item.id, name, detail, input);
    // Each child's lifecycle is the engine's word on THAT thread, carried
    // separately from this call's own settlement; the full message is the
    // child's report, retained through the bounded report contract — the
    // 160-char first line below is only the collapsed row's text. One
    // result's fan-out shares ONE report budget and one update count
    // (round 4): past them a child gets its state without a report, or
    // nothing this time — its earlier state stands, and the log says so.
    let reportBudget = OUTPUT_CAP_BYTES;
    let updates = 0;
    let omittedUpdates = 0;
    for (const [thread, st] of states) {
      const state = collabState(st?.status);
      if (!state) continue;
      if (updates >= CodexEventMapper.MAX_TASK_UPDATES_PER_RESULT) {
        omittedUpdates++;
        continue;
      }
      updates++;
      if (prompt && (item.tool === "spawnAgent" || item.tool === "spawn_agent") && !this.taskLabels.has(thread) && this.subagentAnchor.has(thread)) {
        this.taskLabels.set(thread, firstLine(prompt, 96));
      }
      let message: ReturnType<typeof capOutput> | undefined;
      if (typeof st?.message === "string" && st.message && reportBudget > 0) {
        message = capOutput(st.message, Math.min(OUTPUT_CAP_BYTES, reportBudget));
        reportBudget -= Buffer.byteLength(message.text, "utf8") + Buffer.byteLength(message.tail ?? "", "utf8");
      }
      this.emitTask(thread, state, message);
    }
    if (omittedUpdates) log.warn(`collab result ${item.id}: ${omittedUpdates} child state update(s) past the per-result cap were not forwarded`);
    this.finishCollabCall(item, states);
  }

  // The engine's own name for each child thread (the spawn prompt's first
  // line), repeated on every task_update so the retained newest update
  // still names the task after replay compaction.
  private taskLabels = new Map<string, string>();
  // Child-lane bookkeeping (verified live 2026-09-15): the child's item ids
  // → its anchor (so deltas, streamed output, and results ride the lane),
  // the ids each thread owns (forgotten together when the thread settles),
  // which threads the engine currently calls running, and the child's
  // latest final answer per thread — its report, retained already capped.
  private childItems = new Map<string, string>();
  private childThreadItems = new Map<string, Set<string>>();
  private runningChildren = new Set<string>();
  // Threads a CHILD spawned: they share their parent's deck, so their own
  // lifecycle words must never restate that deck's task row.
  private adoptedThreads = new Set<string>();
  private childReports = new Map<string, ReturnType<typeof capOutput>>();
  private static readonly MAX_CHILD_ITEMS = 5_000;
  private readonly maxChildItems: number;
  private childFloodReported = false;

  /** Is this thread one the parent announced as its child? */
  isChildThread(thread: string): boolean {
    return this.subagentAnchor.has(thread);
  }

  /** The deck a child's item belongs to, for attributing its approval ask. */
  parentOf(itemId: string): string | undefined {
    return this.childItems.get(itemId);
  }

  /** One notification from a CHILD thread — its own items, prose, and
   *  streamed output, nested under the anchor via parentId. Turn and status
   *  bookkeeping for the child is not the parent's turn and is ignored. */
  handleChild(thread: string, method: string, params: unknown) {
    const parentId = this.subagentAnchor.get(thread);
    if (!parentId) return;
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "item/started":
        this.onChildItem(thread, parentId, p["item"] as CodexItem | undefined, "started");
        break;
      case "item/completed":
        this.onChildItem(thread, parentId, p["item"] as CodexItem | undefined, "completed");
        break;
      // A delta belongs to an item this lane tracks; one for an item the
      // flood cap refused (or that never started) is dropped here rather
      // than read by the shared delta paths as root output.
      case "item/agentMessage/delta": {
        const id = String(p["itemId"] ?? "");
        if (this.childItems.has(id)) this.onProseDelta(id, String(p["delta"] ?? ""));
        break;
      }
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const id = String(p["itemId"] ?? "");
        if (this.childItems.has(id)) this.streamToolOutput(id, String(p["delta"] ?? ""));
        break;
      }
      // The same live-output and update paths the root's running rows get:
      // the agent's typed stdin, an MCP call's progress, a patch snapshot.
      case "item/commandExecution/terminalInteraction": {
        const id = String(p["itemId"] ?? "");
        if (this.childItems.has(id)) this.onTerminalInteraction(id, p["stdin"]);
        break;
      }
      case "item/mcpToolCall/progress": {
        const id = String(p["itemId"] ?? "");
        if (this.childItems.has(id)) this.onMcpProgress(id, p["message"]);
        break;
      }
      case "item/fileChange/patchUpdated": {
        const id = String(p["itemId"] ?? "");
        if (this.childItems.has(id)) this.publishFileChange(id, p["changes"]);
        break;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const delta = String(p["delta"] ?? "");
        const id = String(p["itemId"] ?? "");
        if (!delta || !this.childItems.has(id)) break;
        this.thinkingStreamed.add(id);
        const forwarded = this.subagentProse.take(parentId, delta);
        if (forwarded) this.options.emit({ type: "thinking_delta", text: forwarded, parentId });
        break;
      }
      default:
        break; // turn/*, thread/status/*, token usage: the child's own bookkeeping
    }
  }

  private onChildItem(thread: string, parentId: string, item: CodexItem | undefined, phase: ItemPhase) {
    if (!item || typeof item.type !== "string" || typeof item.id !== "string") return;
    if (!this.trackChildItem(thread, item.id, parentId)) return;
    switch (item.type) {
      case "agentMessage": {
        const declared = item.phase === "commentary" ? "commentary" : item.phase === "final_answer" ? "final" : undefined;
        if (declared) this.phaseOf.set(item.id, declared);
        if (phase !== "completed") return;
        const text = typeof item.text === "string" ? item.text : "";
        // The child's final answer is its report — retained already capped,
        // the shape the task_update will carry, never the engine-sized text.
        if (declared === "final" && text) this.childReports.set(thread, capOutput(text));
        const streamed = this.prose.get(item.id)?.streamed ?? 0;
        this.prose.delete(item.id);
        const rest = text.slice(streamed);
        if (rest) this.emitProse(item.id, rest);
        return;
      }
      case "reasoning":
        this.onReasoning(item, phase);
        return;
      case "commandExecution":
        this.onCommandExecution(item, phase);
        return;
      case "fileChange":
        this.onFileChange(item, phase);
        return;
      case "mcpToolCall":
        this.onMcpToolCall(item, phase);
        return;
      case "webSearch":
        this.onWebSearch(item, phase);
        return;
      // The same honest tool records the root gets — parented through the
      // item table; the image handlers withhold their painting for a child.
      case "dynamicToolCall":
        this.onDynamicToolCall(item, phase);
        return;
      case "imageView":
        if (phase === "completed") this.onImageView(item);
        return;
      case "imageGeneration":
        if (phase === "completed") this.onImageGeneration(item);
        return;
      case "sleep":
        if (phase === "completed") this.onSleep(item);
        return;
      case "collabAgentToolCall":
        this.onChildCollabCall(parentId, item, phase);
        return;
      case "subAgentActivity":
        if (phase === "completed") this.onChildSubagentActivity(parentId, item);
        return;
      default:
        return; // a child's own housekeeping items (its user message echo, plans…) are not the lane
    }
  }

  /** Parentage for one child item, remembered until its thread settles.
   *  False when the flood cap refuses it: an untracked item is dropped
   *  whole — never processed as root output, which is exactly what a noisy
   *  child would gain from filling the table (PR #122 review). */
  private trackChildItem(thread: string, id: string, parentId: string): boolean {
    if (this.childItems.has(id)) return true;
    if (this.childItems.size >= this.maxChildItems) {
      if (!this.childFloodReported) {
        this.childFloodReported = true;
        log.warn(`codex child lane: past ${this.maxChildItems} tracked child items this session; further child items are not shown`);
        this.options.emit({ type: "notice", text: "Codex subagent activity past Mirafold's per-session limit is not shown.", kind: "info" });
      }
      return false;
    }
    this.childItems.set(id, parentId);
    let ids = this.childThreadItems.get(thread);
    if (!ids) this.childThreadItems.set(thread, (ids = new Set()));
    ids.add(id);
    return true;
  }

  /** The engine's terminal word on a thread: its items, streaming state, and
   *  retained report are done with. The anchor itself stays (bounded, and a
   *  late update still needs its row). */
  private forgetChildThread(thread: string, cascade = true) {
    for (const id of this.childThreadItems.get(thread) ?? []) {
      this.childItems.delete(id);
      this.prose.delete(id);
      this.phaseOf.delete(id);
      this.announced.delete(id);
      this.thinkingStreamed.delete(id);
    }
    this.childThreadItems.delete(thread);
    this.childReports.delete(thread);
    this.runningChildren.delete(thread);
    // A settled child takes the grandchildren riding its deck with it.
    if (cascade && !this.adoptedThreads.has(thread)) {
      const anchor = this.subagentAnchor.get(thread);
      if (anchor) for (const t of this.adoptedThreads) if (this.subagentAnchor.get(t) === anchor) this.forgetChildThread(t, false);
    }
  }

  /** A thread a CHILD spawned or messaged anchors on that child's own deck —
   *  the nearest visible ancestor — so its items ride the same lane. It gets
   *  no deck or task row of its own: the child's lifecycle is the deck's. */
  private adoptGrandchild(thread: string, parentId: string) {
    if (thread && !this.subagentAnchor.has(thread) && this.subagentAnchor.size < CodexEventMapper.MAX_SUBAGENT_ANCHORS) {
      this.subagentAnchor.set(thread, parentId);
      this.adoptedThreads.add(thread);
      // Running from its spawn: its bookkeeping outlives the root turn until
      // its own terminal word, like a direct child's (PR #122 review).
      this.runningChildren.add(thread);
    }
  }

  /** A child's own collab call: an ordinary row in its deck, its receivers
   *  adopted under the same deck; no task lifecycle is minted for them. */
  private onChildCollabCall(parentId: string, item: CodexItem, phase: ItemPhase) {
    const { name, receivers, detail, input, states } = this.collabShape(item);
    for (const thread of receivers) this.adoptGrandchild(thread, parentId);
    if (phase === "started") {
      this.announceTool(item.id, name, detail, input);
      return;
    }
    this.ensureAnnounced(item.id, name, detail, input);
    this.finishCollabCall(item, states);
    // The child's own word on the threads it waited for releases them.
    for (const [thread, st] of states) {
      const state = collabState(st?.status);
      if (state && state !== "running" && state !== "unknown" && this.adoptedThreads.has(thread)) this.forgetChildThread(thread, false);
    }
  }

  /** A child narrating ITS child's lifecycle: the line rides the child's
   *  lane; a `started` adopts the grandchild thread, a terminal word releases
   *  what the grandchild owned. */
  private onChildSubagentActivity(parentId: string, item: CodexItem) {
    const thread = typeof item.agentThreadId === "string" ? item.agentThreadId : "";
    const kind = typeof item.kind === "string" && item.kind ? inertToken(item.kind, 48) : "activity";
    const who = typeof item.agentPath === "string" && item.agentPath ? inertToken(item.agentPath, 96) : "subagent";
    if (item.kind === "started") this.adoptGrandchild(thread, parentId);
    if (thread && (item.kind === "completed" || item.kind === "interrupted") && this.subagentAnchor.get(thread) === parentId) {
      this.forgetChildThread(thread);
    }
    const forwarded = this.subagentProse.take(parentId, `${who} ${kind}\n`);
    if (forwarded) this.options.emit({ type: "text_delta", text: forwarded, parentId });
  }

  /** One child thread's lifecycle on the wire, anchored on the collab call
   *  that first named it. A thread no call anchored has no row to update. */
  private emitTask(thread: string, state: TaskState, report?: ReturnType<typeof capOutput>) {
    const id = this.subagentAnchor.get(thread);
    if (!id || this.adoptedThreads.has(thread)) return;
    const label = this.taskLabels.get(thread);
    this.options.emit({
      type: "task_update",
      id,
      state,
      ...(label ? { label } : {}),
      ...(report?.text ? { report: report.text } : {}),
      ...(report?.tail !== undefined ? { reportTail: report.tail } : {}),
      ...(report?.omittedBytes !== undefined ? { reportOmittedBytes: report.omittedBytes } : {}),
    });
    // The engine's word decides how long the thread's bookkeeping lives.
    if (state === "running") this.runningChildren.add(thread);
    else if (state !== "unknown") this.forgetChildThread(thread);
  }

  /** A child agent's lifecycle, narrated under its spawn row when the anchor
   *  is known, otherwise as commentary in the transcript — and, as the
   *  engine's own lifecycle word, a task_update on that anchor (TF2.4). */
  private onSubagentActivity(item: CodexItem) {
    const thread = typeof item.agentThreadId === "string" ? item.agentThreadId : "";
    // Engine-chosen identifiers on a narration line: clamped, single-line,
    // controls visible — never raw engine bytes at engine-chosen length.
    const kind = typeof item.kind === "string" && item.kind ? inertToken(item.kind, 48) : "activity";
    const who = typeof item.agentPath === "string" && item.agentPath ? inertToken(item.agentPath, 96) : "subagent";
    let parentId = this.subagentAnchor.get(thread);
    const text = `${who} ${kind}`;
    const lifecycle =
      item.kind === "started" || item.kind === "interacted"
        ? "running"
        : item.kind === "completed"
          ? "completed"
          : item.kind === "interrupted"
            ? "interrupted"
            : undefined;
    // In app-server 0.153.4 a spawn surfaces as THIS event, not as a collab
    // item (verified live 2026-09-15): the announcement itself anchors the
    // child, with an opaque task-scoped handle the projection turns into a
    // placeholder deck. A collab-anchored thread keeps its collab anchor.
    if (item.kind === "started" && thread && !parentId && this.subagentAnchor.size < CodexEventMapper.MAX_SUBAGENT_ANCHORS) {
      parentId = `codex-agent:${childHandle(thread)}`;
      this.subagentAnchor.set(thread, parentId);
    }
    if (lifecycle && parentId) {
      if (!this.taskLabels.has(thread)) this.taskLabels.set(thread, who); // anchored: parentId exists
      const report = lifecycle === "completed" ? this.childReports.get(thread) : undefined;
      this.emitTask(thread, lifecycle, report);
    }
    if (parentId) {
      const forwarded = this.subagentProse.take(parentId, `${text}\n`);
      if (forwarded) this.options.emit({ type: "text_delta", text: forwarded, parentId });
    } else {
      // The same budget for a thread no collab call anchored: N stray events
      // must never mean N wire messages without bound (SECURITY.md).
      const forwarded = this.subagentProse.take(thread || "unanchored", `Subagent ${text}.\n`);
      if (forwarded) this.options.emit({ type: "text_delta", text: forwarded, phase: "commentary" });
    }
  }

  /** The model looked at an image: a row, plus the image itself painted
   *  inline when it is a workspace file the image tool would accept (TS.10). */
  private onImageView(item: CodexItem) {
    const path = typeof item.path === "string" ? item.path : "";
    const shown = path ? displayPath(path, this.options.workspaceDir) : "";
    this.announceTool(item.id, "view_image", shown, { path: shown });
    this.finishTool(item.id, { output: shown ? "(viewed)" : "(no path)" });
    // A subagent never paints (SECURITY.md): its row stands alone.
    if (shown && !this.childItems.has(item.id)) this.paintWorkspaceImage(shown, "viewed by the agent");
  }

  private onImageGeneration(item: CodexItem) {
    const saved = typeof item.savedPath === "string" ? displayPath(item.savedPath, this.options.workspaceDir) : "";
    const prompt = typeof item.revisedPrompt === "string" ? item.revisedPrompt : "";
    const failed = item.status === "failed" || Boolean(item.failure);
    this.announceTool(item.id, "image_generation", firstLine(prompt, 96), { ...(prompt ? { prompt } : {}), ...(saved ? { savedPath: saved } : {}) });
    const failure = capOutput(String(item.failure ?? "failed"));
    this.finishTool(item.id, {
      ...(failed ? outputFields(failure) : { output: saved || "(no file saved)" }),
      isError: failed,
    });
    if (saved && !failed && !this.childItems.has(item.id)) this.paintWorkspaceImage(saved, prompt || "generated image");
  }

  private paintWorkspaceImage(path: string, alt: string) {
    const props = resolveImageProps(this.options.workspaceDir, { path, alt });
    if (typeof props["error"] === "string") return; // outside the workspace, not an image, too big: the row stands alone
    this.options.emit({ type: "render", component: "image", props, id: randomUUID() });
  }

  private onSleep(item: CodexItem) {
    const ms = typeof item.durationMs === "number" ? item.durationMs : undefined;
    const detail = ms === undefined ? "" : ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`;
    this.announceTool(item.id, "sleep", detail, { durationMs: ms });
    this.finishTool(item.id, { output: "(done)" });
  }

  /** Codex apps / dynamic tools: a tool row named the way the engine names it. */
  private onDynamicToolCall(item: CodexItem, phase: ItemPhase) {
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    // Rides the wire as tool_use.name and the activity label: an app-chosen
    // string, so clamped and control-visible.
    const name = inertToken(typeof item.namespace === "string" && item.namespace ? `${item.namespace}.${tool}` : tool, 120);
    const args = typeof item.arguments === "object" && item.arguments !== null ? (item.arguments as Record<string, unknown>) : {};
    const detail = firstLine(Object.values(args).find((v) => typeof v === "string") as string | undefined ?? "", 96);
    if (phase === "started") {
      this.announceTool(item.id, name, detail, args);
      return;
    }
    this.ensureAnnounced(item.id, name, detail, args);
    this.finishTool(item.id, {
      ...outputFields(capOutput(mcpText(item.contentItems))),
      isError: item.status === "failed" || item.success === false,
    });
  }

  private onMcpToolCall(item: CodexItem, phase: ItemPhase) {
    const server = typeof item.server === "string" ? item.server : "";
    const tool = typeof item.tool === "string" ? item.tool : "";
    // Mirafold's generative-UI server becomes the render/artifact message
    // represented by the call rather than a raw tool row. If it did not
    // produce a painting, fall back to the honest call/result record. A
    // SUBAGENT's call never becomes a painting: it is always the honest,
    // parented record (SECURITY.md — subagents cannot paint session-level UI).
    if (server === MIRAFOLD_MCP && !this.childItems.has(item.id)) {
      if (phase === "completed" && item.status !== "failed" && !item.error) {
        const message = this.generativeUIMessage(tool, item);
        if (message) {
          this.options.emit(message);
          return;
        }
      }
      if (phase === "started") return;
    }
    // Engine-chosen strings riding the wire as tool_use.name / detail and
    // the activity label: clamped and control-visible like every other
    // name producer in this mapper.
    const label = inertToken(`${server}.${tool}`, 120);
    const detail = inertToken(tool, 96);
    if (phase === "started") {
      this.announceTool(item.id, label, detail, item.arguments);
      return;
    }
    this.ensureAnnounced(item.id, label, detail, item.arguments);
    this.finishTool(item.id, {
      ...outputFields(capOutput(item.error ? String(item.error.message ?? "") : mcpText(item.result?.content))),
      isError: item.status === "failed" || Boolean(item.error),
      ...(typeof item.durationMs === "number" && item.durationMs >= 0 ? { durationMs: Math.floor(item.durationMs) } : {}),
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
  private ensureAnnounced(id: string, name: string, detail: string, input: unknown, actions?: ToolAction[]) {
    if (!this.announced.has(id)) this.announceTool(id, name, detail, input, actions);
  }

  private announceTool(id: string, name: string, detail: string, input: unknown, actions?: ToolAction[]) {
    this.announced.add(id);
    const parentId = this.childItems.get(id);
    // A child's tool churn never steers the root activity line.
    if (!parentId) this.options.emit({ type: "status", state: "tool", label: name });
    this.options.emit({
      type: "tool_use",
      name,
      detail: detail || undefined,
      id,
      input: typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined,
      ...(actions?.length ? { actions } : {}),
      ...(parentId ? { parentId } : {}),
    });
  }

  private finishTool(
    id: string,
    result: {
      output: string;
      isError?: boolean;
      truncatedBytes?: number;
      tail?: string;
      omittedBytes?: number;
      exitCode?: number;
      durationMs?: number;
    },
  ) {
    this.announced.delete(id);
    this.fileChangeSnapshots.delete(id);
    // The final snapshot goes out before the authoritative result, so a
    // pre-result viewport never holds a stale tail.
    this.live.settle(id);
    const parentId = this.childItems.get(id);
    this.options.emit({ type: "tool_result", ...result, id, ...(parentId ? { parentId } : {}) });
  }

  private generativeUIMessage(tool: string, item: CodexItem): SessionMsg | null {
    const args =
      item.arguments && typeof item.arguments === "object"
        ? (item.arguments as Record<string, unknown>)
        : {};
    return generativeUIMsg(tool, args, extractRenderId(item), this.options.workspaceDir);
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

type TaskState = Extract<SessionMsg, { type: "task_update" }>["state"];

/** A collab call's per-thread `CollabAgentStatus` → the wire's task state. */
/** A bounded handle for an engine thread id inside a synthetic anchor: the
 *  id itself while it fits the checkpoint id budget with room for the prefix,
 *  else its digest — a live and a restored session must agree on the row. */
function childHandle(thread: string): string {
  return thread.length <= 200 ? thread : createHash("sha256").update(thread).digest("base64url");
}

function collabState(status: unknown): TaskState | undefined {
  switch (status) {
    case "pendingInit":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "errored":
    case "notFound":
      return "failed";
    case "interrupted":
    case "shutdown":
      return "interrupted";
    default:
      return undefined;
  }
}

/** Codex's own best-effort parse of a command (`commandActions`) mapped to
 *  the wire's display classification: only when EVERY parsed action is a
 *  read, listing, or search — one `unknown` (or a pipeline the parser could
 *  not name) means the command stays a command. Targets are the engine's
 *  parsed paths/queries, clamped, never re-derived from the command text. */
// A pipeline the parser splits into more actions than this is not routine
// display material, and the checkpoint decoder caps the array at 1,000:
// the adapter must never emit what the store would refuse (review
// 2026-09-15).
export const MAX_COMMAND_ACTIONS = 200;

export function commandActions(raw: unknown): ToolAction[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_COMMAND_ACTIONS) return undefined;
  const actions: ToolAction[] = [];
  for (const entry of raw) {
    const a = entry as { type?: unknown; path?: unknown; query?: unknown; name?: unknown } | null;
    const kind =
      a?.type === "read" ? "read" : a?.type === "listFiles" ? "list" : a?.type === "search" ? "search" : undefined;
    if (!kind) return undefined;
    const target =
      kind === "search"
        ? [a?.query, a?.path].find((v): v is string => typeof v === "string" && v.length > 0)
        : kind === "read"
          ? [a?.name, a?.path].find((v): v is string => typeof v === "string" && v.length > 0)
          : typeof a?.path === "string" && a.path
            ? a.path
            : undefined;
    actions.push({ kind, ...(target ? { target: inertToken(target, 200) } : {}) });
  }
  return actions;
}
