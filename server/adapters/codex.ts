import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  Codex,
  type McpToolCallItem,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
} from "@openai/codex-sdk";
import type { WireMsg } from "../protocol";
import { type AgentSession, type TodoItem, capOutput, joinTextBlocks } from "./types";
import { MIRAFOLD_MCP, RENDER_ID_RE, generativeUIMsg, renderMcpCommand } from "./render-mcp-cmd";
import { AsyncQueue, CLOSE } from "./async-queue";

// The generative-UI MCP server injected into Codex (P.3). Codex loads MCP
// servers as stdio subprocesses, so Mirafold's render tools live in a
// standalone process (server/render-mcp.ts) rather than in-process like the
// Claude adapter's makeRenderServer. renderMcpCommand resolves how to spawn
// it: tsx + TS source in dev, node + the esbuild twin in the packaged install.
const RENDER_MCP = renderMcpCommand();

// The model label until the real one is known: no model configured means
// Codex resolves its own default, which the rollout lookup below then names.
// Comparisons against this are "is the label still the stand-in?" checks.
const MODEL_STAND_IN = "codex";

export function mcpText(content: unknown): string {
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return joinTextBlocks(content);
}

/**
 * The model Codex ACTUALLY resolved for a thread (the analog of Claude's
 * system/init model, F.3): the SDK's event stream never names it, but Codex's
 * own session record does — the rollout file at
 * `<codexHome>/sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl`, whose
 * turn_context line carries `payload.model` (e.g. "gpt-5.6-sol", exactly what
 * the terminal's own header shows). Read-only, local, and failure-silent:
 * any miss returns undefined and the label stays the "codex" stand-in.
 * The date dir is the session's LOCAL start date — today is checked first,
 * yesterday too for a session straddling midnight.
 */
/** `<codexHome>/sessions/YYYY/MM/DD` — the CLI's rollout layout, LOCAL date.
 *  Exported for the test fixture (the bangShell pattern), so the layout is
 *  written down exactly once. */
export const rolloutDateDir = (codexHome: string, d: Date) =>
  path.join(
    codexHome,
    "sessions",
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  );

export async function resolveRolloutModel(
  threadId: string,
  codexHome: string,
): Promise<string | undefined> {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  for (const dir of [rolloutDateDir(codexHome, today), rolloutDateDir(codexHome, yesterday)]) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue; // no sessions that day
    }
    const file = names.find((n) => n.endsWith(`-${threadId}.jsonl`));
    if (!file) continue;
    let text: string;
    try {
      text = await readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"model"')) continue;
      try {
        const model = (JSON.parse(line) as { payload?: { model?: unknown } }).payload?.model;
        if (typeof model === "string" && model) return model;
      } catch {
        // a torn line mid-write — the retry loop will see it whole
      }
    }
  }
  return undefined;
}

// The component id the render-mcp stub assigned (structuredContent is the
// primary channel; the "(id: …)" text is a fallback if an engine drops it) —
// used so the browser paints the same id the agent can re-send for update-in-place.
export function extractRenderId(item: McpToolCallItem): string {
  const sc = item.result?.structured_content as { renderId?: unknown } | undefined;
  if (sc && typeof sc.renderId === "string") return sc.renderId;
  const m = mcpText(item.result?.content).match(RENDER_ID_RE);
  if (m) return m[1];
  const argId = (item.arguments as { id?: unknown } | undefined)?.id;
  return typeof argId === "string" ? argId : randomUUID();
}

/**
 * The Codex adapter: OpenAI's Codex, driven through its own `@openai/codex-sdk`
 * engine. One `Thread` lives for the object's lifetime and carries the warm
 * conversation across turns (unlike Claude's single long-lived `query()`, Codex
 * runs one `runStreamed` per turn on the persistent thread). Its event stream is
 * normalized into the shared `WireMsg` union — no protocol change (P.2 spike).
 *
 * Faithful-skin posture (see the inherit-don't-invent principle): this adapter
 * passes ONLY Mirafold's genuine concerns — the session working directory
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
  // Where Codex keeps auth/config/sessions — the CLI's own CODEX_HOME rule.
  // A field (not read at call time) so tests can point it at a fixture.
  private codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  private lookupThreadId?: string;
  private lookupRunning = false;

  get modelName(): string {
    return this.modelLabel;
  }

  constructor(opts: { workspaceDir: string; model?: string }) {
    const workspaceDir = path.resolve(opts.workspaceDir);
    mkdirSync(workspaceDir, { recursive: true });
    this.modelLabel = opts.model ?? MODEL_STAND_IN;
    // No `env`: the SDK then inherits process.env, so the CLI finds the user's
    // ~/.codex auth + config. No `apiKey` unless one is set (ChatGPT login path).
    const codex = new Codex({
      ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
      // Inject Mirafold's generative-UI tools as a stdio MCP server. Codex
      // calls them like any tool; the adapter turns those calls into render/
      // artifact WireMsgs below (it never reaches back into this subprocess).
      // `default_tools_approval_mode: "approve"` auto-approves THIS server's
      // tools only — they're Mirafold's own side-effect-free UI emission, the
      // direct analog of the Claude adapter auto-allowing mcp__ui__*. Without it,
      // headless exec mode (which can't prompt for approval) cancels the call.
      config: {
        mcp_servers: {
          [MIRAFOLD_MCP]: {
            command: RENDER_MCP.command,
            args: RENDER_MCP.args,
            default_tools_approval_mode: "approve",
          },
        },
      },
    });
    this.thread = codex.startThread({
      workingDirectory: workspaceDir,
      skipGitRepoCheck: true, // workspace dirs aren't git repos
      ...(opts.model ? { model: opts.model } : {}),
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
        // A lookup that ran out its window mid-turn gets another chance now —
        // by turn end the rollout file certainly has its turn_context line.
        if (this.modelLabel === MODEL_STAND_IN) void this.learnModel();
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
      case "thread.started":
        // Carries the resume id; the persistent Thread already holds warmth,
        // so nothing to emit — but the id names the rollout file, the one
        // place Codex records the model it actually resolved. Learn it there
        // (fleet/status-bar parity with Claude's system/init, F.3), unless a
        // model was configured — then the label already tells the truth.
        if (this.modelLabel === MODEL_STAND_IN) {
          this.lookupThreadId = ev.thread_id;
          void this.learnModel();
        }
        break;
    }
  }

  /** Poll the rollout file for the resolved model. Its turn_context line is
      written when the first turn's context is assembled — measured ~3s after
      thread.started reaches us — so the window is a generous 20 × 500ms;
      turn.completed re-kicks a missed lookup. Silent on failure: the "codex"
      stand-in is still honest, just less specific. */
  private async learnModel() {
    if (this.lookupRunning || !this.lookupThreadId) return;
    this.lookupRunning = true;
    try {
      for (let attempt = 0; attempt < 20 && !this.closed && this.modelLabel === MODEL_STAND_IN; attempt++) {
        const model = await resolveRolloutModel(this.lookupThreadId, this.codexHome);
        if (model) {
          this.modelLabel = model;
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      this.lookupRunning = false;
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
        // Our own generative-UI server: never a raw tool row — turn the call
        // into the render/artifact WireMsg it stands for (P.3). The stub server
        // just validated the args and handed back the id; we paint it here.
        if (item.server === MIRAFOLD_MCP) {
          if (phase === "completed" && item.status !== "failed" && !item.error) {
            this.emitGenerativeUI(item);
          }
          break;
        }
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

  /** Turn a Mirafold MCP tool call into the render/artifact WireMsg it stands for. */
  private emitGenerativeUI(item: McpToolCallItem) {
    const args =
      item.arguments && typeof item.arguments === "object"
        ? (item.arguments as Record<string, unknown>)
        : {};
    const msg = generativeUIMsg(item.tool, args, extractRenderId(item));
    if (msg) this.emit(msg);
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
