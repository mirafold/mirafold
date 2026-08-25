import { randomUUID } from "node:crypto";
import type { McpToolCallItem, ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { SessionMsg } from "../protocol";
import { type TodoItem, capOutput, joinTextBlocks } from "./types";
import { MIRAFOLD_MCP, generativeUIMsg, renderIdFor } from "./render-mcp-cmd";
import { ChecklistPainter } from "./wire-helpers";
import { convertMermaidCharts } from "./mermaid-chart";

type Emit = (message: SessionMsg) => void;

export function mcpText(content: unknown): string {
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return joinTextBlocks(content);
}

// The component id the render-mcp stub assigned — the shared precedence in
// render-mcp-cmd.ts, fed Codex's three channels.
export function extractRenderId(item: McpToolCallItem): string {
  return renderIdFor({
    structured: item.result?.structured_content,
    ackText: mcpText(item.result?.content),
    argId: (item.arguments as { id?: unknown } | undefined)?.id,
  });
}

export class CodexEventMapper {
  private announced = new Set<string>();
  private readonly checklist: ChecklistPainter;

  constructor(
    private readonly options: {
      emit: Emit;
      workspaceDir: string;
      modelName: () => string | undefined;
      modelUnknown: () => boolean;
      learnModel: () => void;
      turnDiagnostic: (value: unknown) => string;
      providerDiagnostic: (value: unknown) => string;
      onThreadStarted: (threadId: string) => void;
    },
  ) {
    this.checklist = new ChecklistPainter(options.emit);
  }

  endTurn() {
    this.checklist.reset();
  }

  handle(event: ThreadEvent, end: () => void) {
    switch (event.type) {
      case "turn.started":
        this.options.emit({ type: "status", state: "thinking" });
        break;
      case "item.started":
        this.onItem(event.item, "started");
        break;
      case "item.updated":
        this.onItem(event.item, "updated");
        break;
      case "item.completed":
        this.onItem(event.item, "completed");
        break;
      case "turn.completed": {
        const usage = event.usage;
        this.options.emit({
          type: "usage",
          model: this.options.modelName(),
          // cached_input_tokens is a subset of input_tokens (already counted);
          // reasoning is output-side cost.
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens + usage.reasoning_output_tokens,
        });
        // A lookup that ran out its window mid-turn gets another chance now —
        // by turn end the rollout file certainly has its turn_context line.
        if (this.options.modelUnknown()) this.options.learnModel();
        end();
        break;
      }
      case "turn.failed":
        this.options.emit({
          type: "error",
          message: this.options.turnDiagnostic(event.error.message),
        });
        end();
        break;
      case "error":
        this.options.emit({ type: "error", message: this.options.turnDiagnostic(event.message) });
        end();
        break;
      case "thread.started":
        // The session owns the resume id; the mapper only reports the event
        // and starts model discovery when the configured label is still unknown.
        this.options.onThreadStarted(event.thread_id);
        if (this.options.modelUnknown()) this.options.learnModel();
        break;
    }
  }

  /** Normalize one thread item. `phase` distinguishes start vs. finish. */
  private onItem(item: ThreadItem, phase: "started" | "updated" | "completed") {
    switch (item.type) {
      case "agent_message":
        // Any mermaid xychart the model still hand-wrote becomes the real
        // chart component; all other text passes through verbatim.
        if (phase === "completed") {
          for (const segment of convertMermaidCharts(item.text)) {
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
        break;
      case "reasoning":
        if (phase === "completed") {
          this.options.emit({ type: "status", state: "thinking" });
          this.options.emit({ type: "thinking_delta", text: item.text });
        }
        break;
      case "command_execution": {
        if (phase === "started") {
          this.announceTool(item.id, "Shell", item.command, { command: item.command });
        } else if (phase === "completed") {
          this.ensureAnnounced(item.id, "Shell", item.command, { command: item.command });
          const capped = capOutput(item.aggregated_output ?? "");
          // Codex reports probe commands (grep with no match, a failing
          // test run) as status "completed" with a nonzero exit, and its
          // own TUI shows them as ordinary completed commands — only
          // status "failed" is an error. The exit code stays visible as
          // an annotation, so nothing the terminal showed is lost.
          const failed = item.status === "failed";
          const exitNote =
            !failed && item.exit_code != null && item.exit_code !== 0
              ? `${capped.text ? "\n" : ""}(exit ${item.exit_code})`
              : "";
          this.finishTool(item.id, {
            output: capped.text + exitNote,
            truncatedBytes: capped.truncatedBytes,
            isError: failed,
          });
        }
        break;
      }
      case "file_change": {
        if (phase !== "completed") break;
        const paths = item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
        this.announceTool(item.id, "apply_patch", paths, { changes: item.changes });
        this.finishTool(item.id, {
          output: paths || "(no changes)",
          isError: item.status === "failed",
        });
        break;
      }
      case "mcp_tool_call": {
        // Mirafold's generative-UI server becomes the render/artifact message
        // represented by the call rather than a raw tool row.
        if (item.server === MIRAFOLD_MCP) {
          if (phase === "completed" && item.status !== "failed" && !item.error) {
            this.emitGenerativeUI(item);
          }
          break;
        }
        const label = `${item.server}.${item.tool}`;
        if (phase === "started") {
          this.announceTool(item.id, label, item.tool, item.arguments);
        } else if (phase === "completed") {
          this.ensureAnnounced(item.id, label, item.tool, item.arguments);
          const capped = capOutput(item.error ? item.error.message : mcpText(item.result?.content));
          this.finishTool(item.id, {
            output: capped.text,
            truncatedBytes: capped.truncatedBytes,
            isError: item.status === "failed" || Boolean(item.error),
          });
        }
        break;
      }
      case "web_search":
        if (phase !== "completed") break;
        this.announceTool(item.id, "web_search", item.query, { query: item.query });
        this.finishTool(item.id, { output: "(results returned to the agent)" });
        break;
      case "todo_list":
        this.emitChecklist(item.items);
        break;
      case "error":
        // This item is a non-fatal Codex warning. Fatal stream errors are
        // handled above and end the turn.
        if (phase === "completed") {
          this.options.emit({
            type: "notice",
            text: this.options.providerDiagnostic(item.message),
            kind: "warning",
            source: "codex",
          });
        }
        break;
    }
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

  private emitGenerativeUI(item: McpToolCallItem) {
    const args =
      item.arguments && typeof item.arguments === "object"
        ? (item.arguments as Record<string, unknown>)
        : {};
    const message = generativeUIMsg(
      item.tool,
      args,
      extractRenderId(item),
      this.options.workspaceDir,
    );
    if (message) this.options.emit(message);
  }

  private emitChecklist(items: { text: string; completed: boolean }[]) {
    const todos: TodoItem[] = items.map((item) => ({
      content: item.text,
      status: item.completed ? "completed" : "pending",
    }));
    this.checklist.paint(todos);
  }
}
