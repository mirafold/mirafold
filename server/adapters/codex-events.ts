import { randomUUID } from "node:crypto";
import type { SessionMsg } from "../protocol";
import { type TodoItem, capOutput, joinTextBlocks, OUTPUT_CAP_BYTES, SubagentProseBudget } from "./types";
import { resolveImageProps } from "../render-image";
import { MIRAFOLD_MCP, generativeUIMsg, renderIdFor } from "./render-mcp-cmd";
import { ChecklistPainter, UnknownKindReporter, inertToken } from "./wire-helpers";
import { CODEX_IGNORED_ITEMS, CODEX_IGNORED_METHODS } from "./codex-ledger";
import { describePatchChange, displayPath, normalizePatchChanges } from "./codex-patch";
import { createLogger } from "../log";
import { convertMermaidCharts } from "./mermaid-chart";

const log = createLogger("codex-events");

// Reaching the live-output ceiling is said once on the stream itself: an
// interrupted command settles from that stream, and a silent cut would read
// as "that was all the output" (release review 2026-09-01).
export const streamCapMarker = (cap: number) =>
  `\n(… live output capped at ${Math.round(cap / 1000)} KB — the settled result reports how much was cut …)`;
export const STREAM_CAP_MARKER = streamCapMarker(OUTPUT_CAP_BYTES);

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
  // Streamed tool output (TS.11): UTF-8 bytes forwarded per running item, capped
  // like the final output so a chatty command cannot flood the ring.
  private streamed = new Map<string, number>();
  private capMarked = new Set<string>();
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
    },
  ) {
    this.checklist = new ChecklistPainter(options.emit);
    this.unknown = new UnknownKindReporter(options.emit, "Codex", (message) => log.warn(message));
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
    this.prose.clear();
    this.phaseOf.clear();
    this.streamed.clear();
    this.capMarked.clear();
    this.fileChangeSnapshots.clear();
    this.subagentProse.clear();
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
        this.options.emit(this.proseMsg(itemId, prefix));
      }
      state.holding = true;
      return;
    }
    const pendingLength = combined.endsWith("``") ? 2 : combined.endsWith("`") ? 1 : 0;
    const ready = pendingLength ? combined.slice(0, -pendingLength) : combined;
    state.pending = pendingLength ? combined.slice(-pendingLength) : "";
    if (!ready) return;
    state.streamed += ready.length;
    this.options.emit(this.proseMsg(itemId, ready));
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

  private proseMsg(itemId: string, text: string): SessionMsg {
    const phase = this.phaseOf.get(itemId);
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
        this.options.emit(this.proseMsg(item.id, segment.text));
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
   *  for a row already announced, capped at the same size as final output. */
  private streamToolOutput(itemId: string, delta: string) {
    if (!delta || !this.announced.has(itemId)) return;
    const cap = this.options.outputCapBytes ?? OUTPUT_CAP_BYTES;
    const sent = this.streamed.get(itemId) ?? 0;
    // Past the ceiling nothing more streams — but the ceiling itself is said
    // once, even when it was zero to begin with.
    const marker = this.capMarked.has(itemId) ? "" : streamCapMarker(cap);
    if (sent >= cap) {
      if (marker) {
        this.capMarked.add(itemId);
        this.options.emit({ type: "tool_output_delta", id: itemId, text: marker });
      }
      return;
    }
    const room = cap - sent;
    const bytes = Buffer.from(delta, "utf8");
    const truncated = bytes.length > room;
    const reached = bytes.length >= room;
    const text = truncated ? utf8Prefix(bytes, room) : delta;
    this.streamed.set(itemId, reached ? cap : sent + bytes.length);
    if (reached) this.capMarked.add(itemId);
    this.options.emit({ type: "tool_output_delta", id: itemId, text: text + (reached ? marker : "") });
  }

  /** A collab call (spawn / wait / send…) is a tool row named by the engine's
   *  own tool name; the first call naming a child thread anchors that
   *  thread's later activity (TS.9). Inner child content still needs
   *  per-thread subscriptions the adapter does not open — recorded. */
  private onCollabCall(item: CodexItem, phase: ItemPhase) {
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
    for (const thread of receivers) {
      if (!this.subagentAnchor.has(thread) && this.subagentAnchor.size < CodexEventMapper.MAX_SUBAGENT_ANCHORS)
        this.subagentAnchor.set(thread, item.id);
    }
    if (phase === "started") {
      this.announceTool(item.id, name, detail, input);
      return;
    }
    this.ensureAnnounced(item.id, name, detail, input);
    const states =
      typeof item.agentsStates === "object" && item.agentsStates !== null
        ? Object.entries(item.agentsStates as Record<string, { status?: unknown; message?: unknown }>)
        : [];
    // Engine-sized fan-out: build lines only up to the output ceiling and
    // say how many were left, instead of materializing every state first
    // (release review 2026-09-01).
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
      output: item.status === "declined" ? "(declined)" : capped.text || "(done)",
      truncatedBytes: capped.truncatedBytes,
      isError: item.status === "failed" || item.status === "declined" || failed,
    });
  }

  /** A child agent's lifecycle, narrated under its spawn row when the anchor
   *  is known, otherwise as commentary in the transcript. */
  private onSubagentActivity(item: CodexItem) {
    const thread = typeof item.agentThreadId === "string" ? item.agentThreadId : "";
    // Engine-chosen identifiers on a narration line: clamped, single-line,
    // controls visible — never raw engine bytes at engine-chosen length.
    const kind = typeof item.kind === "string" && item.kind ? inertToken(item.kind, 48) : "activity";
    const who = typeof item.agentPath === "string" && item.agentPath ? inertToken(item.agentPath, 96) : "subagent";
    const parentId = this.subagentAnchor.get(thread);
    const text = `${who} ${kind}`;
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
    if (shown) this.paintWorkspaceImage(shown, "viewed by the agent");
  }

  private onImageGeneration(item: CodexItem) {
    const saved = typeof item.savedPath === "string" ? displayPath(item.savedPath, this.options.workspaceDir) : "";
    const prompt = typeof item.revisedPrompt === "string" ? item.revisedPrompt : "";
    const failed = item.status === "failed" || Boolean(item.failure);
    this.announceTool(item.id, "image_generation", firstLine(prompt, 96), { ...(prompt ? { prompt } : {}), ...(saved ? { savedPath: saved } : {}) });
    const failure = capOutput(String(item.failure ?? "failed"));
    this.finishTool(item.id, {
      output: failed ? failure.text : saved || "(no file saved)",
      ...(failed && failure.truncatedBytes !== undefined ? { truncatedBytes: failure.truncatedBytes } : {}),
      isError: failed,
    });
    if (saved && !failed) this.paintWorkspaceImage(saved, prompt || "generated image");
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
    const capped = capOutput(mcpText(item.contentItems));
    this.finishTool(item.id, {
      output: capped.text,
      truncatedBytes: capped.truncatedBytes,
      isError: item.status === "failed" || item.success === false,
    });
  }

  private onMcpToolCall(item: CodexItem, phase: ItemPhase) {
    const server = typeof item.server === "string" ? item.server : "";
    const tool = typeof item.tool === "string" ? item.tool : "";
    // Mirafold's generative-UI server becomes the render/artifact message
    // represented by the call rather than a raw tool row. If it did not
    // produce a painting, fall back to the honest call/result record.
    if (server === MIRAFOLD_MCP) {
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
    this.fileChangeSnapshots.delete(id);
    this.options.emit({ type: "tool_result", ...result, id });
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

/** Decode the longest complete UTF-8 prefix within a byte budget. A stream
 *  slice must not split a character or grow back over the cap as U+FFFD. */
function utf8Prefix(bytes: Buffer, maxBytes: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = Math.min(bytes.length, maxBytes); end >= Math.max(0, maxBytes - 3); end--) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // A UTF-8 scalar is at most four bytes; back up to its leading byte.
    }
  }
  return "";
}
