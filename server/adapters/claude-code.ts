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

export function resultText(content: unknown): string {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content
      .map((b) => (b?.type === "text" ? String(b.text) : `[${String(b?.type ?? "block")}]`))
      .join("\n");
  else text = content == null ? "" : JSON.stringify(content);
  return text; // capping happens at emit via capOutput (T2.3)
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
  // In-flight permission prompts, keyed by wire id → resolver.
  private pendingAsks = new Map<string, (allow: boolean) => void>();

  // T2.6: label shown in the status bar (the SDK falls back to its own
  // default when `model` is unset, so we keep a readable stand-in).
  private modelLabel: string;

  constructor(opts?: { workspaceDir?: string; model?: string }) {
    const workspaceDir = path.resolve(opts?.workspaceDir ?? "workspace");
    mkdirSync(workspaceDir, { recursive: true }); // spawn fails on a missing cwd
    const model = opts?.model ?? process.env.DEFAULT_MODEL;
    this.modelLabel = model ?? "default";
    this.q = query({
      prompt: this.promptStream(),
      options: {
        model,
        cwd: workspaceDir,
        canUseTool: makeCanUseTool(workspaceDir, this.ask),
        // settingSources is intentionally UNSET so it matches the CLI default
        // (user + project + local). genui-shell is a different *view* of the
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
    if (!this.closed) this.queue.push(text);
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
    }
  }
}
