import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionMsg } from "../protocol";
import { type TodoItem, capOutput, joinTextBlocks } from "./types";
import { MIRAFOLD_MCP, generativeUIMsg, renderIdFor } from "./render-mcp-cmd";
import { ChecklistPainter, UnknownKindReporter } from "./wire-helpers";
import { createLogger } from "../log";

const log = createLogger("codex-events");
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
  phase?: unknown;
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

// The adapter's ledger against Codex's protocol digest
// (codex-protocol.digest.json, from `codex app-server generate-json-schema`;
// codex-protocol.test.ts holds them equal). Every kind the engine can send is
// either handled below, deliberately ignored here with its reason, or
// reported by UnknownKindReporter the first time it arrives.
export const CODEX_HANDLED_ITEMS = [
  "agentMessage",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "contextCompaction",
  "plan",
  "enteredReviewMode",
  "exitedReviewMode",
] as const;
export const CODEX_IGNORED_ITEMS: Record<string, string> = {
  userMessage: "the engine's echo of the prompt; the registry already emitted user_prompt",
  functionCallOutput: "the raw output of a call already represented by its own item",
  hookPrompt: "a hook's prompt fragments are the engine's input, not its output",
};
export const CODEX_HANDLED_METHODS = [
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "turn/plan/updated",
  "thread/tokenUsage/updated",
  "error",
  "warning",
  "deprecationNotice",
  "configWarning",
  "guardianWarning",
  "model/rerouted",
] as const;
export const CODEX_IGNORED_METHODS: Record<string, string> = {
  "thread/started": "the session consumes it on thread/start",
  "thread/status/changed": "the registry derives status from the stream itself",
  "thread/name/updated": "Mirafold names sessions by folder",
  "thread/goal/updated": "goal bookkeeping for Codex's own UI",
  "thread/goal/cleared": "goal bookkeeping for Codex's own UI",
  "thread/queue/changed": "Mirafold serializes prompts itself",
  "thread/archived": "thread lifecycle for Codex's own UI",
  "thread/unarchived": "thread lifecycle for Codex's own UI",
  "thread/deleted": "thread lifecycle for Codex's own UI",
  "thread/closed": "thread lifecycle for Codex's own UI",
  "thread/reverted": "thread lifecycle for Codex's own UI",
  "thread/project/updated": "project bookkeeping for Codex's own UI",
  "thread/settings/updated": "settings echo; the adapter owns its /model and /effort state",
  "thread/environment/connected": "remote-environment plumbing Mirafold does not use",
  "thread/environment/disconnected": "remote-environment plumbing Mirafold does not use",
  "project/changed": "project bookkeeping for Codex's own UI",
  "skills/changed": "the prompt-option refresh re-lists skills per turn",
  "hook/started": "Codex hooks run silently in the terminal too",
  "hook/completed": "Codex hooks run silently in the terminal too",
  "item/autoApprovalReview/started": "internal review of an auto-approval; the approval itself is surfaced",
  "item/autoApprovalReview/completed": "internal review of an auto-approval; the approval itself is surfaced",
  "autoApprovalReview/strictReviewRequired": "internal review of an auto-approval; the approval itself is surfaced",
  "item/reasoning/summaryPartAdded": "a paragraph boundary inside reasoning already streamed as deltas",
  "item/mcpToolCall/progress": "progress ticks of a call whose completion is shown",
  "serverRequest/resolved": "the answer to an ask the session itself resolved",
  "command/exec/outputDelta": "the exec runtime's own streaming; the item completion is shown",
  "process/outputDelta": "background process plumbing not represented in the transcript",
  "process/exited": "background process plumbing not represented in the transcript",
  "item/commandExecution/terminalInteraction": "interactive-terminal plumbing not represented in the transcript",
  "mcpServer/oauthLogin/completed": "MCP server administration",
  "mcpServer/startupStatus/updated": "MCP server administration",
  "mcpServer/event/stream/notification": "MCP server administration",
  "account/updated": "account administration",
  "account/login/completed": "account administration",
  "app/list/updated": "Codex apps administration",
  "remoteControl/status/changed": "remote-control administration",
  "externalAgentConfig/import/progress": "config import administration",
  "externalAgentConfig/import/completed": "config import administration",
  "fs/changed": "the Changes panel watches the tree itself",
  "fuzzyFileSearch/sessionUpdated": "Codex's own file picker",
  "fuzzyFileSearch/sessionCompleted": "Codex's own file picker",
  "thread/realtime/started": "voice/realtime mode Mirafold does not drive",
  "thread/realtime/itemAdded": "voice/realtime mode Mirafold does not drive",
  "thread/realtime/item/started": "voice/realtime mode Mirafold does not drive",
  "thread/realtime/item/transcript/delta": "voice/realtime mode Mirafold does not drive",
  "thread/realtime/item/completed": "voice/realtime mode Mirafold does not drive",
  "thread/realtime/transcript/delta": "voice/realtime mode Mirafold does not drive",
  "thread/realtime/transcript/done": "voice/realtime mode Mirafold does not drive",
  "thread/realtime/outputAudio/delta": "voice/realtime mode Mirafold does not drive",
  "thread/realtime/sdp": "voice/realtime mode Mirafold does not drive",
  "thread/realtime/error": "voice/realtime mode Mirafold does not drive",
  "thread/realtime/closed": "voice/realtime mode Mirafold does not drive",
  "windows/worldWritableWarning": "Windows-only setup diagnostics",
  "windowsSandbox/setupCompleted": "Windows-only setup diagnostics",
  "turn/moderationMetadata": "moderation bookkeeping with no user-facing text",
  "model/safetyBuffering/updated": "moderation bookkeeping with no user-facing text",
  "model/verification": "model bookkeeping with no user-facing text",
  "thread/compacted": "the contextCompaction item is the shown form of the same event",
  "account/rateLimits/updated":
    "rate-limit bookkeeping on every turn; an 'approaching the limit' notice like Claude's needs the params shape recorded first",
};

/** One file change on an apply_patch row, as the browser renders it. */
export type PatchChange = {
  path: string;
  kind: "add" | "delete" | "update";
  /** A unified diff for `update`; the whole file's content for `add`/`delete`. */
  diff: string;
  movePath?: string;
};

/**
 * app-server v2 delivers `fileChange.changes` as `[{ path, kind: { type,
 * move_path }, diff }]` — `kind` is an OBJECT (read from the wire 2026-08-30;
 * the earlier fixture guessed a string and every edit row was titled
 * "[object Object]" for a month). The persisted rollout form is a map keyed
 * by path with `unified_diff`/`content`; both are accepted so a fixture from
 * either source normalizes the same way. Paths inside the workspace are
 * shown relative to it, as the terminal prints them.
 */
export function normalizePatchChanges(raw: unknown, workspaceDir: string): PatchChange[] {
  const entries: { path: string; change: Record<string, unknown> }[] = [];
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (typeof c === "object" && c !== null && typeof (c as { path?: unknown }).path === "string") {
        entries.push({ path: (c as { path: string }).path, change: c as Record<string, unknown> });
      }
    }
  } else if (typeof raw === "object" && raw !== null) {
    for (const [path, c] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof c === "object" && c !== null) entries.push({ path, change: c as Record<string, unknown> });
    }
  }
  return entries.map(({ path, change }) => {
    const kindRaw = change.kind ?? change.type;
    const kindObj = typeof kindRaw === "object" && kindRaw !== null ? (kindRaw as Record<string, unknown>) : undefined;
    const kindName = String(kindObj ? kindObj.type : kindRaw ?? "update");
    const kind: PatchChange["kind"] = kindName === "add" || kindName === "delete" ? kindName : "update";
    const diffRaw = change.diff ?? change.unified_diff ?? change.content;
    const moveRaw = kindObj?.move_path ?? change.move_path;
    const out: PatchChange = {
      path: displayPath(path, workspaceDir),
      kind,
      diff: typeof diffRaw === "string" ? diffRaw : "",
    };
    if (typeof moveRaw === "string" && moveRaw) out.movePath = displayPath(moveRaw, workspaceDir);
    return out;
  });
}

function displayPath(p: string, workspaceDir: string): string {
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(workspaceDir, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

/** "Updated server/x.ts", "Added NOTES.md", "Deleted a.md", "Moved a → b". */
export function describePatchChange(c: PatchChange): string {
  if (c.movePath) return `Moved ${c.path} → ${c.movePath}`;
  return `${c.kind === "add" ? "Added" : c.kind === "delete" ? "Deleted" : "Updated"} ${c.path}`;
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
          text: `Codex rerouted the model${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}.`,
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
    if (phase !== "completed") return;
    const changes = normalizePatchChanges(item.changes, this.options.workspaceDir);
    const summary = changes.map(describePatchChange).join(", ");
    // The row carries the normalized changes — path, kind, and the unified
    // diff (full content for add/delete) — so the browser draws the patch
    // the way the terminal prints it.
    this.announceTool(item.id, "apply_patch", summary, { changes });
    const declined = item.status === "declined";
    this.finishTool(item.id, {
      output: declined ? "(declined)" : summary || "(no changes)",
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
