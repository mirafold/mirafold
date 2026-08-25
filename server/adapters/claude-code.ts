import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  query,
  type Query,
  type SDKResultMessage,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type { PromptOption, SessionMsg } from "../protocol";
import { makeCanUseTool } from "../security/permissions";
import { makeRenderServer, RENDER_GUIDANCE } from "../render-tools";
import { ResumeIdState } from "./resume-id";
import { ChecklistPainter, PermissionLedger } from "./wire-helpers";
import {
  type AgentSession,
  type TodoItem,
  capOutput,
  emitPromptOptions,
  envWithout,
  errText,
  joinTextBlocks,
  toolDetail,
  PERMISSION_TIMEOUT_MS,
  SubagentProseBudget,
} from "./types";
import { AsyncQueue, CLOSE } from "./async-queue";
import { createLogger, scrubSelectedEndpoint, verbose } from "../log";

const log = createLogger("claude-code");

// The in-process render-tools MCP server's registered name — the SDK exposes
// its tools to the model as `mcp__<name>__<tool>`, so both spellings below
// derive from this one constant.
const UI_MCP = "ui";

// The SDK's session-task-list tools — folded into the live checklist,
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

/** Map a TodoWrite input to the todo-list component's props.
 *  null = not a TodoWrite shape at all; [] = a VALID empty list — the agent
 *  clearing its tasks. Collapsing the two to null would make an empty
 *  TodoWrite a no-op: deleted items would stay painted and a later TaskCreate
 *  would resurrect them. */
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
  return out;
}

// Capping happens at emit via capOutput, never here.
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return joinTextBlocks(content);
  return content == null ? "" : JSON.stringify(content);
}

type ClaudeEndpointAuth = "api-key" | "auth-token" | "none";

/** Build the SDK environment for an explicitly chosen backend. Start with
 * both Anthropic credentials and the ambient endpoint removed, then add back
 * only the one credential mode the server bound to this exact destination. */
function localEndpointEnv(
  endpoint: string | undefined,
  auth: ClaudeEndpointAuth,
): Record<string, string> {
  const env = envWithout(
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
  );
  const destination = endpoint ?? process.env.ANTHROPIC_BASE_URL;
  if (destination !== undefined) env.ANTHROPIC_BASE_URL = destination;
  if (auth === "api-key" && process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  } else if (auth === "auth-token" && process.env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
  } else if (auth === "none") {
    // Claude's Anthropic-compatible local path requires a present token even
    // when the target ignores it. This fixed dummy is never a daemon secret.
    env.ANTHROPIC_AUTH_TOKEN = "ollama";
  }
  return env;
}

/** A first-party key/token choice must not inherit a custom endpoint or a
 * second ambiguous Anthropic credential. */
function firstPartyCredentialEnv(): Record<string, string> {
  if (process.env.ANTHROPIC_API_KEY) {
    return envWithout("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN");
  }
  return envWithout("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY");
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
  private listeners = new Set<(msg: SessionMsg) => void>();
  private engine: Query;
  private closed = false;
  // pump() exited — the SDK stream is gone. Distinct from `closed`: this is
  // the abnormal path (stream death without close()), where a queued prompt
  // would otherwise sit in the void forever.
  private dead = false;
  // tool_use ids we announced on the wire — results for anything else
  // (render tools, subagent internals) must not paint orphan records.
  private announcedTools = new Set<string>();
  // The live checklist. `tasks` is the session task list (id → item),
  // built from Task*/TodoWrite calls and persisted across turns like the SDK's
  // own list; `checklist` paints it (one render block per turn). `taskSeq`
  // mirrors the SDK's 1-based sequential ids so TaskUpdate.taskId lines up.
  private tasks = new Map<string, TodoItem>();
  private taskSeq = 0;
  private checklist = new ChecklistPainter((msg) => this.emit(msg));
  // Did this turn stream any assistant text via stream_event? If so, the
  // buffered `assistant` text message is a duplicate and must be skipped. If
  // NOT (slash-command output — /context, /usage, unsupported commands — all
  // arrive as buffered assistant text with zero deltas), the buffered text is
  // the ONLY copy and must be emitted, or the command runs but nothing paints.
  private streamedText = false;
  // Per-subagent narration budget for the turn (cleared with it).
  private subagentProse = new SubagentProseBudget();
  private permissions = new PermissionLedger((msg) => this.emit(msg));

  // Label shown in the status bar. Undefined when `model` is unset (the SDK
  // falls back to its own default) until system/init names the real one — the
  // UI shows nothing, never a stand-in that reads as a model name.
  private modelLabel: string | undefined;
  private providerSessionId: string;
  private resumeIdState: ResumeIdState;
  private endpointForRedaction?: string;

  get modelName(): string | undefined {
    return this.modelLabel;
  }

  get resumeId(): string | undefined {
    return this.resumeIdState.value;
  }

  onResumeId(cb: (id: string) => void) {
    this.resumeIdState.onChange(cb);
  }

  // `engine` is the test seam (like Codex's thread swap / MIRAFOLD_GEMINI_BIN):
  // query() spawns the real CLI at construction, so tests must inject a
  // scripted stand-in here — there is no later moment to swap it.
  // `kind`/`endpoint` carry the onboarding picker's backend choice.
  // Undefined = inherit the process env untouched.
  constructor(opts: {
    workspaceDir: string;
    model?: string;
    kind?: "api-key" | "subscription" | "local";
    endpoint?: string;
    endpointAuth?: ClaudeEndpointAuth;
    resumeId?: string;
    engine?: typeof query;
  }) {
    const workspaceDir = path.resolve(opts.workspaceDir);
    mkdirSync(workspaceDir, { recursive: true }); // spawn fails on a missing cwd
    const model = opts.model ?? process.env.DEFAULT_MODEL;
    this.modelLabel = model;
    this.endpointForRedaction =
      opts.kind === "local" ? (opts.endpoint ?? process.env.ANTHROPIC_BASE_URL) : undefined;
    this.providerSessionId = opts.resumeId ?? randomUUID();
    this.resumeIdState = new ResumeIdState(opts.resumeId || undefined);
    this.engine = (opts.engine ?? query)({
      prompt: this.promptStream(),
      options: {
        ...(opts.resumeId
          ? { resume: opts.resumeId }
          : { sessionId: this.providerSessionId }),
        model,
        cwd: workspaceDir,
        // The chosen backend is enforced per-session through the SDK's own
        // env (never a process.env mutation). Discovered/unauthenticated
        // endpoints get only the fixed dummy token; configured endpoints get
        // exactly the credential MODE the server bound to that destination.
        ...(opts.kind === "local"
          ? { env: localEndpointEnv(opts.endpoint, opts.endpointAuth ?? "none") }
          : opts.kind === "api-key"
            ? { env: firstPartyCredentialEnv() }
            : {}),
        canUseTool: makeCanUseTool(workspaceDir, this.ask),
        // settingSources is intentionally UNSET so it matches the CLI default
        // (user + project + local). Mirafold is a different *view* of the
        // terminal, so a user's own Claude Code config must apply here exactly
        // as it does there — their settings.json permission allowlists and deny
        // rules, their CLAUDE.md, their memory. Switching from the terminal to
        // this has to be seamless and unsurprising. Honoring host allowlists
        // (those tools then don't re-prompt in the browser) and letting
        // "remember X" write to the real ~/.claude memory are terminal-native
        // behaviors, not leaks to isolate against — `settingSources: []` would
        // mistake the terminal's own behavior for a threat. (`canUseTool` still
        // runs for anything the user's rules don't already decide.)
        includePartialMessages: true, // gives us token-level text deltas
        // MIRAFOLD_DEBUG=1 surfaces the engine's own stderr (the SDK
        // swallows it otherwise) — where a bad key or dead CLI explains itself.
        ...(verbose ? { stderr: (data: string) => log.debug(`stderr — ${this.safeEngineText(data)}`) } : {}),
        // Opt-in extended thinking; unset leaves the preset's behavior
        // (trigger words like "think hard" still work either way).
        ...(process.env.MAX_THINKING_TOKENS
          ? { maxThinkingTokens: Number(process.env.MAX_THINKING_TOKENS) }
          : {}),
        mcpServers: { [UI_MCP]: makeRenderServer((msg) => this.emit(msg), workspaceDir) },
        systemPrompt: { type: "preset", preset: "claude_code", append: RENDER_GUIDANCE },
      },
    });
    void this.pump();
  }

  refreshPromptOptions() {
    this.engine
      .supportedCommands()
      .then((commands) => {
        if (!this.closed) this.emitCommandCatalog(commands);
      })
      .catch((err) => log.debug(`command catalog unavailable — ${this.safeEngineText(errText(err))}`));
  }

  private emitCommandCatalog(commands: SlashCommand[]) {
    const options: PromptOption[] = commands.flatMap((rawCommand) => {
      const command = rawCommand as Partial<SlashCommand>;
      if (typeof command.name !== "string" || !command.name) return [];
      const aliases = Array.isArray(command.aliases)
        ? command.aliases.filter((alias): alias is string => typeof alias === "string")
        : [];
      return [{
        trigger: "/",
        value: `/${command.name}`,
        label: command.name,
        ...(typeof command.description === "string"
          ? { description: command.description }
          : {}),
        ...(typeof command.argumentHint === "string" && command.argumentHint
          ? { argumentHint: command.argumentHint }
          : {}),
        kind: "command",
        source: "claude-code",
        ...(aliases.length ? { aliases } : {}),
      }];
    });
    emitPromptOptions((msg) => this.emit(msg), options);
  }

  /** Provider failures and stderr can echo the request destination. Replace
   * this session's exact selected endpoint before either the browser or logger
   * sees the text, then apply the daemon's generic credential scrubber. */
  private safeEngineText(value: unknown): string {
    return scrubSelectedEndpoint(String(value), this.endpointForRedaction);
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

  onMessage(cb: (msg: SessionMsg) => void) {
    this.listeners.add(cb);
  }

  interrupt() {
    if (this.closed) return;
    // A pending permission prompt would keep the aborted turn hanging —
    // interrupt means the user walked away from it: deny.
    this.permissions.denyAll();
    // The SDK also emits a result for the aborted turn; the extra turn_end
    // after the abort settles is a client-side no-op, kept as a guarantee.
    this.engine
      .interrupt()
      .then(() => this.emit({ type: "turn_end" }))
      .catch(() => {}); // interrupting an idle session is not an error
  }

  resolvePermission(id: string, allow: boolean) {
    this.permissions.resolve(id, allow);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.permissions.denyAll();
    this.queue.push(CLOSE);
    this.engine.interrupt().catch(() => {});
  }

  /** Pause the tool call on a browser prompt; deny on timeout or close. */
  private ask = (tool: string, detail: string): Promise<boolean> => {
    if (this.closed) return Promise.resolve(false);
    return this.permissions.ask({ tool, detail }, PERMISSION_TIMEOUT_MS);
  };

  /** Fold a Task-family or TodoWrite call into the live checklist. */
  private trackTasks(name: string, input: unknown) {
    const rec = (input ?? {}) as Record<string, unknown>;
    if (name === "TodoWrite") {
      // TodoWrite replaces the whole list in one call — an EMPTY list
      // included, or deleted items linger and get resurrected by the next
      // TaskCreate.
      const todos = normalizeTodos(input);
      if (todos !== null) {
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
    this.checklist.paint([...this.tasks.values()]);
  }

  private emit(msg: SessionMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  /** A subagent's narration/reasoning chunk: budget-capped, then onto its
   *  deck's lane — or nothing at all once the budget is spent. */
  private emitSubagentProse(parentId: string, type: "text_delta" | "thinking_delta", text: string) {
    const capped = this.subagentProse.take(parentId, text);
    if (capped) this.emit({ type, text: capped, parentId });
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

  /** Normalize the SDK's event stream into SessionMsg. */
  private async pump() {
    try {
      for await (const msg of this.engine) {
        switch (msg.type) {
          case "stream_event": {
            // Subagent deltas never arrive here (SDK streams are main-session
            // only); a subagent's prose forwards from its complete assistant
            // messages below. Guard kept fail-safe.
            if (msg.parent_tool_use_id) break;
            const ev = msg.event;
            if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
              this.streamedText = true; // mark this turn as streamed
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
            // Subagent tool CALLS are shown, nested, and a subagent's PROSE
            // rides too: the SDK never forwards subagent token deltas
            // (stream_event stays main-session-only — the break above is belt
            // and suspenders), but its COMPLETE assistant messages arrive
            // live mid-run tagged parent_tool_use_id, so text and thinking
            // blocks forward at message grain, budget-capped per subagent.
            // parentId = the spawn tool_use id.
            const parentId = msg.parent_tool_use_id ?? undefined;
            for (const block of msg.message.content) {
              // Buffered assistant text with no preceding deltas — the
              // shape slash-command output arrives in. For the PARENT, emit
              // only when this turn streamed nothing (else it's a duplicate
              // of the stream) — renders the command output that would
              // otherwise vanish. For a SUBAGENT there is never a
              // delta stream to duplicate: forward, capped.
              if (block.type === "text") {
                if (typeof block.text !== "string" || !block.text) continue;
                if (parentId) this.emitSubagentProse(parentId, "text_delta", block.text);
                else if (!this.streamedText) this.emit({ type: "text_delta", text: block.text });
                continue;
              }
              // A subagent's reasoning (parent thinking streams via
              // stream_event above; emitting it here too would duplicate).
              if (block.type === "thinking") {
                if (parentId && typeof block.thinking === "string" && block.thinking)
                  this.emitSubagentProse(parentId, "thinking_delta", block.thinking);
                continue;
              }
              if (block.type !== "tool_use") continue;
              // Render tools already paint their own component block.
              if (block.name.startsWith(`mcp__${UI_MCP}__`)) continue;
              // The agent's task list becomes one live checklist
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
          case "system":
            this.handleSystemMsg(msg);
            break;
          case "rate_limit_event":
            this.handleRateLimitMsg(msg);
            break;
          case "result":
            this.handleResultMsg(msg);
            break;
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.emit({ type: "error", message: this.safeEngineText(errText(err)) });
        this.emit({ type: "turn_end" });
      }
    } finally {
      this.dead = true;
    }
  }

  /** Rate-limit frames, surfaced ONLY when they actually matter — approaching
   *  (allowed_warning) or hitting (rejected) the limit — never on the constant
   *  plain "allowed"; observed live on ordinary turns. */
  private handleRateLimitMsg(msg: object) {
    const info = (msg as { rate_limit_info?: { status?: unknown; rateLimitType?: unknown } })
      .rate_limit_info;
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
  }

  /** The turn's closing frame: surface an error result, report per-turn
   *  usage, reset per-turn state, and end the turn. */
  private handleResultMsg(msg: SDKResultMessage) {
    // Spawns don't outlive their turn; the narration ledger resets with it.
    this.subagentProse.clear();
    if (msg.is_error) {
      const detail = "result" in msg ? msg.result : msg.subtype;
      this.emit({ type: "error", message: this.safeEngineText(detail) });
    }
    // Per-turn usage for the status bar. Input includes cache
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
    this.checklist.reset(); // next turn starts a fresh checklist
    this.streamedText = false; // next turn's streamed/buffered decision is independent
    // A tool announced but never resolved (interrupt mid-call) must not sit
    // in the set for the session's life; results never span turns, so the
    // boundary is the safe clear point (a stale cross-turn straggler is
    // dropped rather than completing an old row).
    this.announcedTools.clear();
    this.emit({ type: "turn_end" });
  }

  /** The engine's out-of-band `system` frames — each subtype an independent
   *  status-bar/notice composition. */
  private handleSystemMsg(msg: object) {
    const sub = (msg as { subtype?: unknown }).subtype;
    if (sub === "commands_changed") {
      const commands = (msg as { commands?: unknown }).commands;
      if (Array.isArray(commands)) this.emitCommandCatalog(commands as SlashCommand[]);
    } else if (sub === "init") {
      const sessionId = (msg as { session_id?: unknown }).session_id;
      if (typeof sessionId === "string" && sessionId) {
        this.providerSessionId = sessionId;
        this.resumeIdState.publish(sessionId);
      }
      // system/init carries the model the engine ACTUALLY resolved
      // (e.g. "claude-fable-5"), which differs from the configured value
      // or the "default" placeholder we start with — show the truth in
      // the status bar, like the terminal's own status line.
      const model = (msg as { model?: unknown }).model;
      if (typeof model === "string" && model) this.modelLabel = model;
    } else if (sub === "api_retry") {
      // The terminal shows "retrying (attempt n)…" here; without
      // this we sit on "thinking…" looking hung through the backoff.
      const m = msg as { attempt?: number; max_retries?: number };
      const n = typeof m.attempt === "number" ? m.attempt : undefined;
      const max = typeof m.max_retries === "number" ? m.max_retries : undefined;
      const which = n && max ? ` (attempt ${n}/${max})` : n ? ` (attempt ${n})` : "";
      this.emit({ type: "notice", text: `API error — retrying${which}…`, kind: "retry" });
    } else if (sub === "compact_boundary") {
      // Context silently compacts — say so.
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
      // The model declined and the turn was retried on a fallback —
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
      // No fallback configured — the turn ends as an error (the
      // result frame carries that); this line says WHY it ended.
      this.emit({
        type: "notice",
        text: "the model declined to complete this request",
        kind: "refusal",
      });
    }
  }
}
