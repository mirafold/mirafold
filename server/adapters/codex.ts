import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Codex, type Thread, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import type { WireMsg } from "../protocol";
import { type AgentSession, type TodoItem, capOutput } from "./types";

/** Unbounded async queue feeding the serial turn worker (one turn at a time). */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((value: T) => void)[] = [];
  push(item: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }
  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const CLOSE = Symbol("close");

function mcpText(content: unknown): string {
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((b) => (b?.type === "text" ? String(b.text) : `[${String(b?.type ?? "block")}]`))
    .join("\n");
}

/**
 * The Codex adapter: OpenAI's Codex, driven through its own `@openai/codex-sdk`
 * engine. One `Thread` lives for the object's lifetime and carries the warm
 * conversation across turns (unlike Claude's single long-lived `query()`, Codex
 * runs one `runStreamed` per turn on the persistent thread). Its event stream is
 * normalized into the shared `WireMsg` union — no protocol change (P.2 spike).
 *
 * Faithful-skin posture (see the inherit-don't-invent principle): this adapter
 * passes ONLY genui-shell's genuine concerns — the session working directory
 * (session ≈ project) and the model when configured. It deliberately sets NO
 * `sandboxMode`/`approvalPolicy`, so Codex reads the user's own
 * `~/.codex/config.toml` and behaves exactly as their terminal `codex` does —
 * never more permissive, never more restrictive. (On stock Ubuntu 24.04 that
 * means Codex's bubblewrap sandbox can't build — but the user's terminal Codex
 * fails identically, so reproducing it is correct, not a bug to paper over.)
 * Codex's SDK exposes no interactive-approval callback, so `permission_request`
 * simply never fires here (optional-feature rule); resolvePermission is a no-op.
 */
export class CodexSession implements AgentSession {
  private queue = new AsyncQueue<string | typeof CLOSE>();
  private listeners = new Set<(msg: WireMsg) => void>();
  private thread: Thread;
  private closed = false;
  private currentAbort?: AbortController;
  // Tool item ids announced on the wire, so a completion doesn't paint an
  // orphan result for something we never opened.
  private announced = new Set<string>();
  // One live checklist per turn (T2.5), reset each turn so it re-anchors.
  private todoRenderId?: string;
  private modelLabel: string;

  constructor(opts?: { workspaceDir?: string; model?: string }) {
    const workspaceDir = path.resolve(opts?.workspaceDir ?? "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    this.modelLabel = opts?.model ?? "codex";
    // No `env`: the SDK then inherits process.env, so the CLI finds the user's
    // ~/.codex auth + config. No `apiKey` unless one is set (ChatGPT login path).
    const codex = new Codex(
      process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {},
    );
    this.thread = codex.startThread({
      workingDirectory: workspaceDir,
      skipGitRepoCheck: true, // workspace dirs aren't git repos
      ...(opts?.model ? { model: opts.model } : {}),
      // sandboxMode / approvalPolicy intentionally UNSET — inherited from the
      // user's own Codex config (faithful skin; see the class doc).
    });
    void this.worker();
  }

  pushPrompt(text: string) {
    if (!this.closed) this.queue.push(text);
  }

  onMessage(cb: (msg: WireMsg) => void) {
    this.listeners.add(cb);
  }

  interrupt() {
    // Abort the in-flight turn; the thread stays warm for the next prompt.
    this.currentAbort?.abort();
  }

  // Codex's SDK has no interactive-approval callback (approvals are governed by
  // the inherited sandbox/approval config), so no browser prompt is ever
  // pending — nothing to resolve.
  resolvePermission(_id: string, _allow: boolean) {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.currentAbort?.abort();
    this.queue.push(CLOSE);
  }

  private emit(msg: WireMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  /** Serial turn loop — Codex runs one turn per prompt on the warm thread. */
  private async worker() {
    while (!this.closed) {
      const item = await this.queue.next();
      if (item === CLOSE) return;
      await this.runTurn(item);
    }
  }

  private async runTurn(text: string) {
    const abort = new AbortController();
    this.currentAbort = abort;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.todoRenderId = undefined; // next turn starts a fresh checklist
      this.emit({ type: "turn_end" });
    };
    try {
      const { events } = await this.thread.runStreamed(text, { signal: abort.signal });
      for await (const ev of events) this.handleEvent(ev, end);
    } catch (err) {
      if (!this.closed && !abort.signal.aborted) {
        this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      end(); // guarantees exactly one turn_end (interrupt, error, or normal)
      if (this.currentAbort === abort) this.currentAbort = undefined;
    }
  }

  private handleEvent(ev: ThreadEvent, end: () => void) {
    switch (ev.type) {
      case "turn.started":
        this.emit({ type: "status", state: "thinking" });
        break;
      case "item.started":
        this.onItem(ev.item, "started");
        break;
      case "item.updated":
        this.onItem(ev.item, "updated");
        break;
      case "item.completed":
        this.onItem(ev.item, "completed");
        break;
      case "turn.completed": {
        const u = ev.usage;
        this.emit({
          type: "usage",
          model: this.modelLabel,
          // cached_input_tokens is a subset of input_tokens (already counted);
          // reasoning is output-side cost.
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens + u.reasoning_output_tokens,
        });
        end();
        break;
      }
      case "turn.failed":
        this.emit({ type: "error", message: ev.error.message });
        end();
        break;
      case "error": // fatal stream error
        this.emit({ type: "error", message: ev.message });
        end();
        break;
      // thread.started carries the resume id; the persistent Thread already
      // holds warmth, so nothing to emit.
    }
  }

  /** Normalize one thread item. `phase` distinguishes start vs. finish. */
  private onItem(item: ThreadItem, phase: "started" | "updated" | "completed") {
    switch (item.type) {
      case "agent_message":
        if (phase === "completed") this.emit({ type: "text_delta", text: item.text });
        break;
      case "reasoning":
        if (phase === "completed") {
          this.emit({ type: "status", state: "thinking" });
          this.emit({ type: "thinking_delta", text: item.text });
        }
        break;
      case "command_execution": {
        if (phase === "started") this.announceTool(item.id, "Shell", item.command, { command: item.command });
        else if (phase === "completed") {
          if (!this.announced.has(item.id))
            this.announceTool(item.id, "Shell", item.command, { command: item.command });
          const capped = capOutput(item.aggregated_output ?? "");
          this.announced.delete(item.id);
          this.emit({
            type: "tool_result",
            output: capped.text,
            truncatedBytes: capped.truncatedBytes,
            isError: item.status === "failed" || (item.exit_code != null && item.exit_code !== 0),
            id: item.id,
          });
        }
        break;
      }
      case "file_change": {
        if (phase !== "completed") break;
        const paths = item.changes.map((c) => `${c.kind} ${c.path}`).join(", ");
        this.announceTool(item.id, "apply_patch", paths, { changes: item.changes });
        this.announced.delete(item.id);
        this.emit({
          type: "tool_result",
          output: paths || "(no changes)",
          isError: item.status === "failed",
          id: item.id,
        });
        break;
      }
      case "mcp_tool_call": {
        const label = `${item.server}.${item.tool}`;
        if (phase === "started") this.announceTool(item.id, label, item.tool, item.arguments);
        else if (phase === "completed") {
          if (!this.announced.has(item.id)) this.announceTool(item.id, label, item.tool, item.arguments);
          this.announced.delete(item.id);
          const capped = capOutput(item.error ? item.error.message : mcpText(item.result?.content));
          this.emit({
            type: "tool_result",
            output: capped.text,
            truncatedBytes: capped.truncatedBytes,
            isError: item.status === "failed" || Boolean(item.error),
            id: item.id,
          });
        }
        break;
      }
      case "web_search": {
        if (phase !== "completed") break;
        this.announceTool(item.id, "web_search", item.query, { query: item.query });
        this.announced.delete(item.id);
        this.emit({
          type: "tool_result",
          output: "(results returned to the agent)",
          id: item.id,
        });
        break;
      }
      case "todo_list":
        // Live checklist, one render id per turn (update-in-place, T2.5).
        this.emitChecklist(item.items);
        break;
      case "error":
        if (phase === "completed") this.emit({ type: "error", message: item.message });
        break;
    }
  }

  private announceTool(id: string, name: string, detail: string, input: unknown) {
    this.announced.add(id);
    this.emit({ type: "status", state: "tool", label: name });
    this.emit({
      type: "tool_use",
      name,
      detail: detail || undefined,
      id,
      input: typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined,
    });
  }

  private emitChecklist(items: { text: string; completed: boolean }[]) {
    if (!items.length) return;
    this.todoRenderId ??= randomUUID();
    const todos: TodoItem[] = items.map((t) => ({
      content: t.text,
      status: t.completed ? "completed" : "pending",
    }));
    this.emit({ type: "render", component: "todo-list", props: { todos }, id: this.todoRenderId });
  }
}
