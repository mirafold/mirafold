import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WireMsg } from "../protocol";
import type { ComponentName } from "../registry-spec";
import { type AgentSession, capOutput } from "./types";

// Same generative-UI stdio MCP server the Codex adapter injects (P.3). Gemini
// loads MCP servers from settings.json, so we write a per-session project
// `.gemini/settings.json` naming it (merged over the user's global config).
const CLOSE = Symbol("close");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDER_MCP_PATH = path.resolve(HERE, "..", "render-mcp.ts");
const TSX_BIN = path.resolve(HERE, "..", "..", "node_modules", ".bin", "tsx");
const GENUI_MCP = "genui";
// Gemini names MCP tools `mcp_<server>_<tool>`; ours therefore start with this.
const MCP_PREFIX = `mcp_${GENUI_MCP}_`;
const GEMINI_BIN = (() => {
  const beside = path.join(path.dirname(process.execPath), "gemini");
  return existsSync(beside) ? beside : "gemini"; // fall back to PATH
})();

const RENDER_TOOL_COMPONENT: Record<string, ComponentName> = {
  render_card: "card",
  render_list: "list",
  render_table: "table",
  render_chart: "chart",
  render_links: "link-group",
};

const DETAIL_KEYS = ["command", "file_path", "pattern", "url", "query", "description", "path"];
function toolDetail(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v) return v;
  }
  const json = JSON.stringify(rec);
  return json === "{}" ? undefined : json.slice(0, 160);
}

/** The component id the render-mcp stub returned, parsed from its output text. */
function parseRenderId(output: unknown): string {
  const m = String(output ?? "").match(/id:\s*([0-9a-fA-F-]{8,})/);
  return m ? m[1] : randomUUID();
}

/**
 * The Gemini CLI adapter: Google's Gemini CLI, driven through its own headless
 * `stream-json` interface (no Node SDK — the JSONL surface IS the programmatic
 * interface). One `gemini -p … -o stream-json` process runs per turn; a stable
 * session id keeps the conversation warm (`--session-id` the first turn,
 * `--resume` after — Gemini's analog of the Codex thread). Events normalize into
 * the shared `WireMsg` union — no protocol change (P.5 spike).
 *
 * Faithful-skin posture (inherit-don't-invent): passes only genui-shell's own
 * concerns — the session cwd and model when set. Auth is API-key (the free
 * Google-login path was deprecated by Google in 2026); the key stays in the
 * server env, injected into the child, never on the wire. Approval for the
 * user's own tools is inherited; only our `genui` MCP server is auto-trusted
 * (the analog of Codex's per-server `approve`), since headless can't prompt.
 */
export class GeminiCliSession implements AgentSession {
  private queue: (string | typeof CLOSE)[] = [];
  private waiter?: (v: string | typeof CLOSE) => void;
  private listeners = new Set<(msg: WireMsg) => void>();
  private closed = false;
  private child?: ChildProcessWithoutNullStreams;
  private sessionId = randomUUID();
  private started = false; // first turn creates the session, later turns resume
  private modelLabel: string;
  private model?: string;
  private workspaceDir: string;
  // Non-genui tool ids we announced, and buffered genui render calls awaiting
  // their tool_result (which carries the assigned component id).
  private announced = new Set<string>();
  private pendingRenders = new Map<string, { tool: string; params: Record<string, unknown> }>();

  constructor(opts?: { workspaceDir?: string; model?: string }) {
    this.workspaceDir = path.resolve(opts?.workspaceDir ?? "workspace");
    mkdirSync(this.workspaceDir, { recursive: true });
    this.model = opts?.model;
    this.modelLabel = opts?.model ?? "gemini";
    this.writeProjectSettings();
    void this.worker();
  }

  // Merge our auth + render MCP server into the session's project settings,
  // preserving anything already there (custom-cwd sessions may have their own).
  private writeProjectSettings() {
    const dir = path.join(this.workspaceDir, ".gemini");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    let cfg: Record<string, any> = {};
    if (existsSync(file)) {
      try {
        cfg = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        /* clobber an unparseable file rather than fail the session */
      }
    }
    cfg.security = { ...cfg.security, auth: { ...cfg.security?.auth, selectedType: "gemini-api-key" } };
    cfg.mcpServers = {
      ...cfg.mcpServers,
      [GENUI_MCP]: { command: TSX_BIN, args: [RENDER_MCP_PATH], trust: true },
    };
    writeFileSync(file, JSON.stringify(cfg, null, 2));
  }

  pushPrompt(text: string) {
    if (this.closed) return;
    if (this.waiter) {
      this.waiter(text);
      this.waiter = undefined;
    } else {
      this.queue.push(text);
    }
  }

  private nextPrompt(): Promise<string | typeof CLOSE> {
    const item = this.queue.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => (this.waiter = resolve));
  }

  onMessage(cb: (msg: WireMsg) => void) {
    this.listeners.add(cb);
  }

  interrupt() {
    this.child?.kill("SIGTERM"); // ends the in-flight turn; session stays warm
  }

  // Headless Gemini has no interactive-approval channel (like Codex exec), so no
  // browser prompt is ever pending — nothing to resolve.
  resolvePermission(_id: string, _allow: boolean) {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.child?.kill("SIGTERM");
    this.pushPrompt(CLOSE as unknown as string);
  }

  private emit(msg: WireMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  private async worker() {
    while (!this.closed) {
      const item = await this.nextPrompt();
      if (item === CLOSE) return;
      await this.runTurn(item);
    }
  }

  private runTurn(text: string): Promise<void> {
    return new Promise((resolve) => {
      const args = ["-p", text, "-o", "stream-json", "--allowed-mcp-server-names", GENUI_MCP];
      if (this.model) args.push("-m", this.model);
      args.push(this.started ? "--resume" : "--session-id", this.sessionId);
      this.started = true;
      this.emit({ type: "status", state: "thinking" });

      const child = spawn(GEMINI_BIN, args, {
        cwd: this.workspaceDir,
        env: process.env, // GEMINI_API_KEY lives here; never serialized to the wire
      });
      this.child = child;

      let buf = "";
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        this.emit({ type: "turn_end" });
        resolve();
      };
      const consume = (line: string) => {
        const s = line.trim();
        if (!s || s[0] !== "{") return; // skip non-JSON noise (e.g. ripgrep warning)
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(s);
        } catch {
          return;
        }
        this.handleEvent(ev);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          consume(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      child.stderr.on("data", () => {}); // diagnostics only; errors also arrive as events
      child.on("close", () => {
        if (buf) consume(buf);
        if (this.child === child) this.child = undefined;
        end(); // covers the case where no `result` event arrived (crash/kill)
      });
      child.on("error", (err) => {
        if (!this.closed) this.emit({ type: "error", message: `gemini spawn failed: ${err.message}` });
        end();
      });
    });
  }

  /** Normalize one JSONL event into WireMsg. */
  private handleEvent(ev: Record<string, unknown>) {
    switch (ev["type"]) {
      case "init":
        if (typeof ev["model"] === "string") this.modelLabel = ev["model"] as string;
        break;
      case "message": {
        // Assistant chunks are the reply; the user echo is our own prompt.
        if (ev["role"] === "assistant" && typeof ev["content"] === "string") {
          this.emit({ type: "text_delta", text: ev["content"] as string });
        }
        break;
      }
      case "tool_use": {
        const name = String(ev["tool_name"] ?? "");
        const id = String(ev["tool_id"] ?? randomUUID());
        const params = (ev["parameters"] ?? {}) as Record<string, unknown>;
        if (name.startsWith(MCP_PREFIX)) {
          // Our generative-UI tools: buffer until the result carries the id.
          this.pendingRenders.set(id, { tool: name.slice(MCP_PREFIX.length), params });
        } else {
          this.announced.add(id);
          this.emit({
            type: "tool_use",
            name,
            detail: toolDetail(params),
            id,
            input: params,
          });
        }
        break;
      }
      case "tool_result": {
        const id = String(ev["tool_id"] ?? "");
        const pending = this.pendingRenders.get(id);
        if (pending) {
          this.pendingRenders.delete(id);
          if (ev["status"] !== "error") this.emitGenerativeUI(pending, ev["output"]);
          break;
        }
        if (!this.announced.delete(id)) break;
        const capped = capOutput(String(ev["output"] ?? ""));
        this.emit({
          type: "tool_result",
          output: capped.text,
          truncatedBytes: capped.truncatedBytes,
          isError: ev["status"] === "error",
          id,
        });
        break;
      }
      case "error":
        if (typeof ev["message"] === "string") this.emit({ type: "error", message: ev["message"] as string });
        break;
      case "result": {
        const stats = (ev["stats"] ?? {}) as Record<string, unknown>;
        this.emit({
          type: "usage",
          model: this.modelLabel,
          inputTokens: Number(stats["input_tokens"] ?? 0),
          outputTokens: Number(stats["output_tokens"] ?? 0),
        });
        break;
      }
    }
  }

  /** A buffered genui tool call → the render/artifact WireMsg it stands for. */
  private emitGenerativeUI(pending: { tool: string; params: Record<string, unknown> }, output: unknown) {
    const id = typeof pending.params["id"] === "string" ? (pending.params["id"] as string) : parseRenderId(output);
    const props = { ...pending.params };
    delete props["id"];
    if (pending.tool === "emit_artifact") {
      this.emit({
        type: "artifact",
        html: typeof props["html"] === "string" ? (props["html"] as string) : "",
        id,
        title: typeof props["title"] === "string" ? (props["title"] as string) : undefined,
      });
      return;
    }
    const component = RENDER_TOOL_COMPONENT[pending.tool];
    if (!component) return;
    this.emit({ type: "render", component, props, id });
  }
}
