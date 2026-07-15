import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WireMsg } from "../protocol";
import { makeCanUseTool } from "../permissions";
import { makeRenderServer, RENDER_GUIDANCE } from "../render-tools";
import {
  type AgentSession,
  type TodoItem,
  capOutput,
  joinTextBlocks,
  toolDetail,
  PERMISSION_TIMEOUT_MS,
} from "./types";
import { AsyncQueue, CLOSE } from "./async-queue";

// The SDK's session-task-list tools (T2.5) — folded into the live checklist,
// never shown as raw tool rows. Note the subagent spawner is named "Agent"
// in this SDK, not "Task", so it doesn't collide.
const TASK_TOOLS = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskStop",
  "TaskOutput",
  "TodoWrite",
]);

/** Map a TodoWrite input to the todo-list component's props (T2.5). */
export function normalizeTodos(input: unknown): TodoItem[] | null {
  if (typeof input !== "object" || input === null) return null;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;
  const out: TodoItem[] = [];
  for (const t of todos) {
    const content = (t as { content?: unknown })?.content;
    if (typeof content !== "string" || !content) continue;
    const s = (t as { status?: unknown })?.status;
    const status = s === "in_progress" || s === "completed" ? s : "pending";
    out.push({ content, status });
  }
  return out.length ? out : null;
}

// Capping happens at emit via capOutput (T2.3), never here.
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return joinTextBlocks(content);
  return content == null ? "" : JSON.stringify(content);
}

/**
 * The reference agent adapter: Claude Code, driven through its own Agent SDK
 * engine. A single query() runs for the life of the object; prompts are fed
 * in through an async generator so the conversation stays warm (and
 * prompt-cached) across turns. Claude-specific fidelity (the `claude_code`
 * preset, inherited settings.json) is scoped to this adapter only — shared
 * code stays agent-neutral.
 */
export class ClaudeCodeSession implements AgentSession {
  private queue = new AsyncQueue<string | typeof CLOSE>();
  private listeners = new Set<(msg: WireMsg) => void>();
  private q: Query;
  private closed = false;
  // pump() exited — the SDK stream is gone. Distinct from `closed`: this is
  // the abnormal path (stream death without close()), where a queued prompt
  // would otherwise sit in the void forever.
  private dead = false;
  // tool_use ids we announced on the wire — results for anything else
  // (render tools, subagent internals) must not paint orphan records.
  private announcedTools = new Set<string>();
  // T2.5: the live checklist. `tasks` is the session task list (id → item),
  // built from Task*/TodoWrite calls and persisted across turns like the SDK's
  // own list; `todoRenderId` is the render block it paints into, reset each
  // turn so the checklist re-anchors to the latest activity. `taskSeq` mirrors
  // the SDK's 1-based sequential ids so TaskUpdate.taskId lines up.
  private tasks = new Map<string, TodoItem>();
  private taskSeq = 0;
  private todoRenderId?: string;
  // F.1: did this turn stream any assistant text via stream_event? If so, the
  // buffered `assistant` text message is a duplicate and must be skipped. If
  // NOT (slash-command output — /context, /usage, unsupported commands — all
  // arrive as buffered assistant text with zero deltas), the buffered text is
  // the ONLY copy and must be emitted, or the command runs but nothing paints.
  private streamedText = false;
  // In-flight permission prompts, keyed by wire id → resolver.
  private pendingAsks = new Map<string, (allow: boolean) => void>();

  // T2.6: label shown in the status bar (the SDK falls back to its own
  // default when `model` is unset, so we keep a readable stand-in).
  private modelLabel: string;

  get modelName(): string {
    return this.modelLabel;
  }

  // `engine` is the test seam (like Codex's thread swap / MIRAFOLD_GEMINI_BIN):
  // query() spawns the real CLI at construction, so tests must inject a
  // scripted stand-in here — there is no later moment to swap it.
  constructor(opts: { workspaceDir: string; model?: string; engine?: typeof query }) {
    const workspaceDir = path.resolve(opts.workspaceDir);
    mkdirSync(workspaceDir, { recursive: true }); // spawn fails on a missing cwd
    const model = opts.model ?? process.env.DEFAULT_MODEL;
    this.modelLabel = model ?? "default";
    this.q = (opts.engine ?? query)({
      prompt: this.promptStream(),
      options: {
        model,
        cwd: workspaceDir,
        canUseTool: makeCanUseTool(workspaceDir, this.ask),
        // settingSources is intentionally UNSET so it matches the CLI default
        // (user + project + local). Mirafold is a different *view* of the
        // terminal, so a user's own Claude Code config must apply here exactly
        // as it does there — their settings.json permission allowlists and deny
        // rules, their CLAUDE.md, their memory. Switching from the terminal to
        // this has to be seamless and unsurprising. Honoring host allowlists
        // (those tools then don't re-prompt in the browser) and letting
        // "remember X" write to the real ~/.claude memory are terminal-native
        // behaviors, not leaks to isolate against — the earlier settingSources:[]
        // mistook the terminal's own behavior for a threat. (`canUseTool` still
        // runs for anything the user's rules don't already decide.)
        includePartialMessages: true, // gives us token-level text deltas
        // R.4g: MIRAFOLD_DEBUG=1 surfaces the engine's own stderr (the SDK
        // swallows it otherwise) — where a bad key or dead CLI explains itself.
        ...(process.env.MIRAFOLD_DEBUG
          ? {
              stderr: (data: string) =>
                console.error(`[${new Date().toISOString()}] [debug claude-code stderr] ${data}`),
            }
          : {}),
        // Opt-in extended thinking; unset leaves the preset's behavior
        // (trigger words like "think hard" still work either way).
        ...(process.env.MAX_THINKING_TOKENS
          ? { maxThinkingTokens: Number(process.env.MAX_THINKING_TOKENS) }
          : {}),
        mcpServers: { ui: makeRenderServer((msg) => this.emit(msg)) },
        systemPrompt: { type: "preset", preset: "claude_code", append: RENDER_GUIDANCE },
      },
    });
    void this.pump();
  }

  pushPrompt(text: string) {
    if (this.closed) return;
    if (this.dead) {
      // Grammar: error, then turn_end — the viewport must not wedge busy on a
      // prompt no engine will ever consume.
      this.emit({ type: "error", message: "agent engine stream ended — start a new session" });
      this.emit({ type: "turn_end" });
      return;
    }
    this.queue.push(text);
  }

  onMessage(cb: (msg: WireMsg) => void) {
    this.listeners.add(cb);
  }

  interrupt() {
    if (this.closed) return;
    // A pending permission prompt would keep the aborted turn hanging —
    // interrupt means the user walked away from it: deny.
    for (const finish of [...this.pendingAsks.values()]) finish(false);
    // The SDK also emits a result for the aborted turn; the extra turn_end
    // after the abort settles is a client-side no-op, kept as a guarantee.
    this.q
      .interrupt()
      .then(() => this.emit({ type: "turn_end" }))
      .catch(() => {}); // interrupting an idle session is not an error
  }

  resolvePermission(id: string, allow: boolean) {
    this.pendingAsks.get(id)?.(allow);
  }

  /** Pause the tool call on a browser prompt; deny on timeout or close. */
  private ask = (tool: string, detail: string): Promise<boolean> => {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = randomUUID();
      const finish = (allow: boolean) => {
        clearTimeout(timer);
        this.pendingAsks.delete(id);
        resolve(allow);
      };
      const timer = setTimeout(() => finish(false), PERMISSION_TIMEOUT_MS);
      this.pendingAsks.set(id, finish);
      this.emit({ type: "permission_request", tool, detail, id });
    });
  };

  /** Fold a Task-family or TodoWrite call into the live checklist (T2.5). */
  private trackTasks(name: string, input: unknown) {
    const rec = (input ?? {}) as Record<string, unknown>;
    if (name === "TodoWrite") {
      // TodoWrite replaces the whole list in one call.
      const todos = normalizeTodos(input);
      if (todos) {
        this.tasks = new Map(todos.map((t, i) => [String(i + 1), t]));
        this.taskSeq = todos.length;
        this.emitChecklist();
      }
      return;
    }
    if (name === "TaskCreate") {
      const subject = typeof rec["subject"] === "string" ? rec["subject"] : "task";
      this.tasks.set(String(++this.taskSeq), { content: subject, status: "pending" });
      this.emitChecklist();
      return;
    }
    if (name === "TaskUpdate") {
      const id = rec["taskId"] === undefined ? "" : String(rec["taskId"]);
      if (!id) return;
      const status = rec["status"];
      if (status === "deleted") {
        this.tasks.delete(id);
        this.emitChecklist();
        return;
      }
      const existing = this.tasks.get(id) ?? { content: `task ${id}`, status: "pending" as const };
      this.tasks.set(id, {
        content: typeof rec["subject"] === "string" ? rec["subject"] : existing.content,
        status:
          status === "in_progress" || status === "completed" || status === "pending"
            ? status
            : existing.status,
      });
      this.emitChecklist();
      return;
    }
    // TaskList / TaskGet / TaskStop / TaskOutput — reads/ops, no list change.
  }

  private emitChecklist() {
    if (this.tasks.size === 0) return;
    this.todoRenderId ??= randomUUID();
    this.emit({
      type: "render",
      component: "todo-list",
      props: { todos: [...this.tasks.values()] },
      id: this.todoRenderId,
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const finish of [...this.pendingAsks.values()]) finish(false);
    this.queue.push(CLOSE);
    this.q.interrupt().catch(() => {});
  }

  private emit(msg: WireMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  private async *promptStream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const item = await this.queue.next();
      if (item === CLOSE) return;
      yield {
        type: "user",
        message: { role: "user", content: item },
        parent_tool_use_id: null,
      };
    }
  }

  /** Normalize the SDK's event stream into WireMsg. */
  private async pump() {
    try {
      for await (const msg of this.q) {
        switch (msg.type) {
          case "stream_event": {
            if (msg.parent_tool_use_id) break; // subagent traffic — not ours to render
            const ev = msg.event;
            if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
              this.streamedText = true; // F.1: mark this turn as streamed
              this.emit({ type: "text_delta", text: ev.delta.text });
            } else if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta") {
              this.emit({ type: "thinking_delta", text: ev.delta.thinking });
            } else if (ev.type === "content_block_start") {
              if (ev.content_block.type === "thinking") {
                this.emit({ type: "status", state: "thinking" });
              } else if (
                ev.content_block.type === "tool_use" ||
                ev.content_block.type === "server_tool_use"
              ) {
                this.emit({ type: "status", state: "tool", label: ev.content_block.name });
              }
            }
            break;
          }
          case "assistant": {
            // Subagent tool CALLS are shown, nested (T2.4); subagent text and
            // thinking stay filtered — those come via stream_event, still
            // dropped above. parentId = the Task tool_use this call belongs to.
            const parentId = msg.parent_tool_use_id ?? undefined;
            for (const block of msg.message.content) {
              // F.1: buffered assistant text with no preceding deltas — the
              // shape slash-command output arrives in. Emit only when this
              // turn streamed nothing (else it's a duplicate of the stream),
              // and never for a subagent (its prose stays filtered like its
              // deltas). Renders the command output that would otherwise vanish.
              if (block.type === "text") {
                if (!parentId && !this.streamedText && typeof block.text === "string" && block.text) {
                  this.emit({ type: "text_delta", text: block.text });
                }
                continue;
              }
              if (block.type !== "tool_use") continue;
              // Render tools already paint their own component block.
              if (block.name.startsWith("mcp__ui__")) continue;
              // T2.5: the agent's task list becomes one live checklist
              // component (updated in place), not raw tool rows. This SDK
              // manages it via the Task* family (TaskCreate/TaskUpdate,
              // successor to TodoWrite); all of it — and its results, since
              // we never announce these — is folded into the checklist.
              // A subagent's own task calls are internal: swallow, don't render.
              if (TASK_TOOLS.has(block.name)) {
                if (!parentId) this.trackTasks(block.name, block.input);
                continue;
              }
              this.announcedTools.add(block.id);
              this.emit({
                type: "tool_use",
                name: block.name,
                detail: toolDetail(block.input),
                id: block.id,
                input:
                  typeof block.input === "object" && block.input !== null
                    ? (block.input as Record<string, unknown>)
                    : undefined,
                parentId,
              });
            }
            break;
          }
          case "user": {
            const parentId = msg.parent_tool_use_id ?? undefined;
            const content = msg.message.content;
            if (!Array.isArray(content)) break; // plain prompt echo, not tool results
            for (const block of content) {
              if (block.type !== "tool_result") continue;
              if (!this.announcedTools.delete(block.tool_use_id)) continue;
              const capped = capOutput(resultText(block.content));
              this.emit({
                type: "tool_result",
                output: capped.text,
                truncatedBytes: capped.truncatedBytes,
                isError: block.is_error === true,
                id: block.tool_use_id,
                parentId,
              });
            }
            break;
          }
          case "system": {
            const sub = (msg as { subtype?: unknown }).subtype;
            if (sub === "init") {
              // F.3: system/init carries the model the engine ACTUALLY resolved
              // (e.g. "claude-fable-5"), which differs from the configured value
              // or the "default" placeholder we start with — show the truth in
              // the status bar, like the terminal's own status line.
              const model = (msg as { model?: unknown }).model;
              if (typeof model === "string" && model) this.modelLabel = model;
            } else if (sub === "api_retry") {
              // F.2: the terminal shows "retrying (attempt n)…" here; without
              // this we sit on "thinking…" looking hung through the backoff.
              const m = msg as { attempt?: number; max_retries?: number };
              const n = typeof m.attempt === "number" ? m.attempt : undefined;
              const max = typeof m.max_retries === "number" ? m.max_retries : undefined;
              const which = n && max ? ` (attempt ${n}/${max})` : n ? ` (attempt ${n})` : "";
              this.emit({ type: "notice", text: `API error — retrying${which}…`, kind: "retry" });
            } else if (sub === "compact_boundary") {
              // F.2: context silently compacts today — say so.
              const trigger = (msg as { compact_metadata?: { trigger?: unknown } }).compact_metadata
                ?.trigger;
              this.emit({
                type: "notice",
                text:
                  trigger === "manual"
                    ? "context compacted"
                    : "context automatically compacted to free space",
                kind: "compaction",
              });
            } else if (sub === "model_refusal_fallback") {
              // F.2: the model declined and the turn was retried on a fallback —
              // without this the swap is invisible.
              const fb = (msg as { fallback_model?: unknown }).fallback_model;
              this.emit({
                type: "notice",
                text:
                  typeof fb === "string" && fb
                    ? `the model declined — retried on ${fb}`
                    : "the model declined — retried on a fallback model",
                kind: "refusal",
              });
            } else if (sub === "model_refusal_no_fallback") {
              // F.2: no fallback configured — the turn ends as an error (the
              // result frame carries that); this line says WHY it ended.
              this.emit({
                type: "notice",
                text: "the model declined to complete this request",
                kind: "refusal",
              });
            }
            break;
          }
          case "rate_limit_event": {
            // F.2: observed live on ordinary turns, so surface it ONLY when it
            // actually matters — approaching (allowed_warning) or hitting
            // (rejected) the limit — never on the constant plain "allowed".
            const info = (
              msg as { rate_limit_info?: { status?: unknown; rateLimitType?: unknown } }
            ).rate_limit_info;
            const status = info?.status;
            if (status === "allowed_warning" || status === "rejected") {
              const t = info?.rateLimitType;
              const scope = typeof t === "string" && t ? ` (${t.replace(/_/g, " ")})` : "";
              this.emit({
                type: "notice",
                text:
                  status === "rejected"
                    ? `rate limit reached${scope} — requests are being throttled`
                    : `approaching the rate limit${scope}`,
                kind: "rate_limit",
              });
            }
            break;
          }
          case "result": {
            if (msg.is_error) {
              const detail = "result" in msg ? msg.result : msg.subtype;
              this.emit({ type: "error", message: String(detail) });
            }
            // T2.6: per-turn usage for the status bar. Input includes cache
            // tokens — that's the real context weight the user is paying for.
            const u = (msg as { usage?: Record<string, number> }).usage;
            if (u) {
              const inputTokens =
                (u["input_tokens"] ?? 0) +
                (u["cache_read_input_tokens"] ?? 0) +
                (u["cache_creation_input_tokens"] ?? 0);
              this.emit({
                type: "usage",
                model: this.modelLabel,
                inputTokens,
                outputTokens: u["output_tokens"] ?? 0,
                costUsd: (msg as { total_cost_usd?: number }).total_cost_usd,
              });
            }
            this.todoRenderId = undefined; // next turn starts a fresh checklist
            this.streamedText = false; // F.1: next turn's streamed/buffered decision is independent
            this.emit({ type: "turn_end" });
            break;
          }
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
        this.emit({ type: "turn_end" });
      }
    } finally {
      this.dead = true;
    }
  }
}
