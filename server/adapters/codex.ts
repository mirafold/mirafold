import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  Codex,
  type CodexOptions,
  type McpToolCallItem,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
} from "@openai/codex-sdk";
import type { WireMsg } from "../protocol";
import { RENDER_GUIDANCE } from "../render-tools";
import { type AgentSession, type TodoItem, capOutput, envWithout, joinTextBlocks } from "./types";
import { MIRAFOLD_MCP, RENDER_ID_RE, generativeUIMsg, renderMcpCommand } from "./render-mcp-cmd";
import { convertMermaidCharts } from "./mermaid-chart";
import { listCodexModels, type CodexModel } from "./codex-model-list";
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

/**
 * V.2: Codex defers ALL MCP tools behind its tool-search mechanism
 * (`tool_search_always_defer_mcp_tools`, hardcoded on in codex-rs — the
 * render tools never appear in the model's direct tool list). Without being
 * told, the model concludes render_chart doesn't exist and hand-writes
 * mermaid/ASCII instead (observed 0/9 render calls live). This addendum to
 * RENDER_GUIDANCE names the deferral and instructs the model to load the
 * tools via tool search — with it, 6/6 live trials called render_chart,
 * including on later turns of the same thread.
 */
export const CODEX_DEFERRED_TOOLS_ADDENDUM = `
## Tool availability note (important)

The render_* tools and emit_artifact above live on the \`${MIRAFOLD_MCP}\` MCP
server and are DEFERRED: they do NOT appear in your direct tool list, but
they ARE available — use tool search to load them, then call them. Never
conclude a render tool is unavailable without searching for it first. For
ANY chart/plot/graph request you MUST load and call render_chart —
hand-written mermaid, ASCII, or SVG charts render as plain code here, never
as visuals.`;

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
  // Retained for the V.2 /model switch: a mid-session model change is
  // `codex.resumeThread(threadId, {...threadOpts, model})` — a fresh Thread
  // on the same warm conversation, so the engine and start options must
  // outlive the constructor.
  private codex: Codex;
  private threadOpts: { workingDirectory: string; skipGitRepoCheck: true; model?: string };
  private threadId?: string;
  private listModels: () => Promise<CodexModel[]>;
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
  private lookupRunning = false;
  // V.2: the SDK exposes no system-prompt/instructions hook (unlike Claude's
  // `systemPrompt.append`), so RENDER_GUIDANCE + the deferred-tools addendum
  // ride ahead of the first user turn instead — the only injection point this
  // engine has. The thread carries them for the rest of the session.
  private firstTurn = true;

  get modelName(): string {
    return this.modelLabel;
  }

  // N.5: `kind`/`endpoint` carry the onboarding picker's backend choice;
  // undefined = the pre-N default (apiKey iff the env var is set, everything
  // inherited). `makeCodex` is the constructor-options test seam (the analog
  // of Claude's `engine` — the options must be capturable at construction).
  constructor(opts: {
    workspaceDir: string;
    model?: string;
    kind?: "api-key" | "subscription" | "local";
    endpoint?: string;
    makeCodex?: (options: CodexOptions) => Codex;
    listModels?: () => Promise<CodexModel[]>;
  }) {
    const workspaceDir = path.resolve(opts.workspaceDir);
    mkdirSync(workspaceDir, { recursive: true });
    this.modelLabel = opts.model ?? MODEL_STAND_IN;
    // The chosen backend, enforced per-session (N.5):
    //   api-key (or no choice with the env var set) → pass the key.
    //   subscription → NO apiKey, and an env override WITHOUT the env key, so
    //     the CLI resolves ~/.codex/auth.json — the explicit choice must win
    //     over the env var's usual precedence.
    //   local endpoint (a discovered server) → the documented custom-provider
    //     recipe (docs/local-models.md Path B), injected per-session: the
    //     server's /v1 as a Responses-API provider, made the default.
    //   Default: inherit process.env, so the CLI finds the user's own auth +
    //     config, exactly as before.
    const kind = opts.kind ?? (process.env.OPENAI_API_KEY ? "api-key" : undefined);
    const codex = (opts.makeCodex ?? ((o: CodexOptions) => new Codex(o)))({
      ...(kind === "api-key" && process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : {}),
      // subscription: the explicit pick must beat the env var's precedence.
      // local: the key has no business in a process pointed at a local server
      // (Codex ignores it once model_provider points elsewhere, but withhold
      // it anyway — symmetry with the claude adapter; 2026-07-17 audit).
      ...(kind === "subscription" || kind === "local"
        ? { env: envWithout("OPENAI_API_KEY") }
        : {}),
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
        ...(kind === "local" && opts.endpoint
          ? {
              model_provider: "mirafold_local",
              model_providers: {
                mirafold_local: {
                  name: "Mirafold-discovered local server",
                  base_url: `${opts.endpoint}/v1`,
                  wire_api: "responses",
                },
              },
            }
          : {}),
      },
    });
    this.codex = codex;
    this.listModels = opts.listModels ?? listCodexModels;
    this.threadOpts = {
      workingDirectory: workspaceDir,
      skipGitRepoCheck: true, // workspace dirs aren't git repos
      ...(opts.model ? { model: opts.model } : {}),
      // sandboxMode / approvalPolicy intentionally UNSET — inherited from the
      // user's own Codex config (faithful skin; see the class doc).
    };
    this.thread = codex.startThread(this.threadOpts);
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

  /** Serial turn loop — Codex runs one turn per prompt on the warm thread.
   *  `/model` is handled here, between turns, so a switch queued behind a
   *  running turn applies in order like any other input. */
  private async worker() {
    while (!this.closed) {
      const item = await this.queue.next();
      if (item === CLOSE) return;
      const trimmed = item.trim();
      if (trimmed === "/model" || trimmed.startsWith("/model ")) {
        await this.runModelCommand(trimmed.slice("/model".length).trim());
      } else {
        await this.runTurn(item);
      }
    }
  }

  /**
   * V.2 /model parity. Terminal Codex's /model opens an interactive picker —
   * TUI chrome the headless SDK has no round-trip for (the engine, sent the
   * literal text, just chats back). So the shell re-skins the picker: the
   * LIST is Codex's own catalog (codex-model-list.ts — the same app-server
   * answer the terminal picker shows), rendered as a `question` component
   * whose click sends `/model <id>` back through this same path. A switch
   * resumes the warm thread with the new model — history intact, exactly
   * what the terminal picker does to a session.
   *
   * Bare slugs the catalog doesn't list still apply: terminal Codex accepts
   * any `-m <model_name>` (its picker hints exactly that for legacy models),
   * so refusing here would be less faithful, not more.
   */
  private async runModelCommand(arg: string) {
    this.emit({ type: "status", state: "thinking" });
    try {
      if (arg === "") {
        let models: CodexModel[];
        try {
          models = await this.listModels();
        } catch (err) {
          this.emit({
            type: "error",
            message: `Could not read the model list from codex: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        this.emitModelPicker(models);
      } else if (/\s/.test(arg) || arg.startsWith("-")) {
        // Hyphen-leading names are rejected HERE rather than trusting the
        // codex CLI's parser to refuse a flag-shaped --model value
        // (2026-07-18 audit): the safety stays local, the error stays clear.
        this.emit({ type: "text_delta", text: "Usage: `/model` to pick, or `/model <model-id>`." });
      } else {
        // Apply: resume the warm thread under the new model (or restart the
        // unstarted one). The label becomes configured-truth immediately —
        // same as constructing with opts.model.
        this.thread = this.threadId
          ? this.codex.resumeThread(this.threadId, { ...this.threadOpts, model: arg })
          : this.codex.startThread({ ...this.threadOpts, model: arg });
        this.threadOpts = { ...this.threadOpts, model: arg };
        this.modelLabel = arg;
        this.emit({ type: "text_delta", text: `Model set to ${arg}.` });
      }
    } finally {
      this.emit({ type: "turn_end" });
    }
  }

  /** The catalog as a clickable picker (a click sends `/model <id>` back
   *  through runModelCommand), or a plain list when the catalog leaves the
   *  question component's 2–4 option range. */
  private emitModelPicker(models: CodexModel[]) {
    const current = (m: CodexModel) =>
      this.modelLabel === MODEL_STAND_IN ? m.isDefault : this.modelLabel === m.id;
    if (models.length >= 2 && models.length <= 4) {
      this.emit({
        type: "render",
        component: "question",
        props: {
          question: "Select a model",
          options: models.map((m) => ({
            label: current(m) ? `${m.displayName} (current)` : m.displayName,
            text: `/model ${m.id}`,
            detail: m.description,
          })),
        },
        id: randomUUID(),
      });
    } else {
      this.emit({
        type: "render",
        component: "list",
        props: {
          title: "Models",
          items: models.map((m) => ({
            text: `**${m.displayName}**${current(m) ? " (current)" : ""} — \`${m.id}\``,
            detail: m.description,
          })),
        },
        id: randomUUID(),
      });
      this.emit({ type: "text_delta", text: "Send `/model <model-id>` to switch." });
    }
    this.emit({
      type: "text_delta",
      text: "\nLegacy models can be set directly with `/model <model_name>`.",
    });
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
      const prompt = this.firstTurn
        ? `${RENDER_GUIDANCE}\n${CODEX_DEFERRED_TOOLS_ADDENDUM}\n\n---\n\n${text}`
        : text;
      this.firstTurn = false;
      const { events } = await this.thread.runStreamed(prompt, { signal: abort.signal });
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
        // so nothing to emit — but the id is kept for the /model switch
        // (resumeThread), and it names the rollout file, the one place Codex
        // records the model it actually resolved. Learn it there
        // (fleet/status-bar parity with Claude's system/init, F.3), unless a
        // model was configured — then the label already tells the truth.
        this.threadId = ev.thread_id;
        if (this.modelLabel === MODEL_STAND_IN) void this.learnModel();
        break;
    }
  }

  /** Poll the rollout file for the resolved model. Its turn_context line is
      written when the first turn's context is assembled — measured ~3s after
      thread.started reaches us — so the window is a generous 20 × 500ms;
      turn.completed re-kicks a missed lookup. Silent on failure: the "codex"
      stand-in is still honest, just less specific. */
  private async learnModel() {
    if (this.lookupRunning || !this.threadId) return;
    this.lookupRunning = true;
    try {
      for (let attempt = 0; attempt < 20 && !this.closed && this.modelLabel === MODEL_STAND_IN; attempt++) {
        const model = await resolveRolloutModel(this.threadId, this.codexHome);
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
        // Any mermaid xychart the model still hand-wrote becomes the real
        // chart component (the V.2 backstop — see mermaid-chart.ts); all
        // other text passes through verbatim.
        if (phase === "completed") {
          for (const seg of convertMermaidCharts(item.text)) {
            if ("text" in seg) this.emit({ type: "text_delta", text: seg.text });
            else
              this.emit({
                type: "render",
                component: "chart",
                props: seg.chart as unknown as Record<string, unknown>,
                id: randomUUID(),
              });
          }
        }
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
