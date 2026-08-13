import { randomUUID } from "node:crypto";
import type { WireMsg } from "../protocol";
import { capOutput, toolDetail, type TodoItem } from "./types";
import { generativeUIMsg, MIRAFOLD_MCP, RENDER_ID_RE } from "./render-mcp-cmd";
import type { OpenCodeEvent } from "./opencode-client";

// OpenCode advertises MCP tools as `<server>_<tool>` (OC.0 capture:
// `mirafold_render_card`), so this prefix is the recognition test.
const MCP_PREFIX = `${MIRAFOLD_MCP}_`;

type PartKind = "text" | "reasoning" | "tool" | "other";

type PartTrack = {
  kind: PartKind;
  // Characters already sent as deltas — the final part snapshot repeats the
  // full text, so emission is always "the suffix beyond this mark". Handles
  // both live streams (delta events) and buffered parts (snapshot only).
  emitted: number;
  announced?: boolean;
  finished?: boolean;
};

type TurnTokens = { input: number; output: number; cost: number };

/**
 * Normalizes the OpenCode event stream (shapes locked by the OC.0 live
 * capture — see opencode.spike.md) into WireMsg. Session-scoped state only;
 * the owning OpenCodeSession supplies turn lifecycle and permission plumbing.
 */
export class OpenCodeEventMapper {
  private parts = new Map<string, PartTrack>();
  // messageID → role. The stream echoes the USER message's parts exactly like
  // assistant ones (observed live, OC.2 probe); without this the user's own
  // prompt — guidance prefix included — replays into the transcript as
  // text_delta. message.updated always precedes a message's parts (OC.0/OC.2
  // captures), so an unknown role is treated as assistant.
  private roles = new Map<string, string>();
  // Per assistant message, latest token/cost report — summed at idle into the
  // turn's one `usage`. Cleared each startTurn so only this turn counts.
  private turnUsage = new Map<string, TurnTokens>();
  private lastModel?: string;
  private lastStatus?: "thinking" | "tool";
  private todoRenderId?: string;

  constructor(
    private readonly options: {
      emit: (msg: WireMsg) => void;
      workspaceDir: string;
      /** The one session this mapper narrates. Subagent child sessions share
       *  the event stream under their own ids and are skipped whole — their
       *  work surfaces through the parent's `task` tool part. */
      isOurs: (sessionID: unknown) => boolean;
      learnModel: (modelID: string) => void;
      onPermissionAsked: (ask: {
        id: string;
        permission: string;
        detail: string;
      }) => void;
      /** A reply observed on the stream (answered by another client, e.g. a
       *  TUI attached to the same engine session) — not our own echo. */
      onPermissionReplied: (requestID: string, reply: string) => void;
      /** One engine `session.idle` for our session — the SESSION scopes it to
       *  the right turn and flushes usage inside the end path. */
      onEngineIdle: () => void;
      endTurn: () => void;
    },
  ) {}

  startTurn() {
    this.turnUsage.clear();
    this.lastStatus = undefined;
    // Part/role tracking resets at the NEXT turn's start, not at turn end:
    // the maps otherwise grow unboundedly over a long session (bughunt
    // 2026-08-13), but a straggler snapshot arriving just after idle must
    // still find its track — a fresh default would re-emit its whole text.
    this.parts.clear();
    this.roles.clear();
  }

  endTurn() {
    this.todoRenderId = undefined;
    this.lastStatus = undefined;
  }

  handle(event: OpenCodeEvent) {
    const p = event.properties ?? {};
    switch (event.type) {
      case "message.updated":
        this.onMessage(p);
        break;
      case "message.part.updated":
        this.onPartSnapshot(p);
        break;
      case "message.part.delta":
        this.onPartDelta(p);
        break;
      case "session.status":
        if (this.options.isOurs(p["sessionID"]) && this.statusType(p) === "busy")
          this.status("thinking");
        break;
      case "todo.updated":
        if (this.options.isOurs(p["sessionID"])) this.onTodos(p["todos"]);
        break;
      case "permission.asked": {
        if (!this.options.isOurs(p["sessionID"])) break;
        const patterns = Array.isArray(p["patterns"]) ? p["patterns"].map(String) : [];
        this.options.onPermissionAsked({
          id: String(p["id"]),
          permission: String(p["permission"] ?? "tool"),
          detail: patterns.join(", ") || String(p["permission"] ?? ""),
        });
        break;
      }
      case "permission.replied":
        if (this.options.isOurs(p["sessionID"]))
          this.options.onPermissionReplied(String(p["requestID"]), String(p["reply"]));
        break;
      case "session.error": {
        // `sessionID` can be absent on transport-level errors; treat those as
        // ours rather than swallow them.
        if (p["sessionID"] !== undefined && !this.options.isOurs(p["sessionID"])) break;
        this.options.emit({ type: "error", message: `OpenCode error: ${sessionErrorText(p)}` });
        this.options.endTurn();
        break;
      }
      case "session.idle":
        if (!this.options.isOurs(p["sessionID"])) break;
        // The session decides whether THIS idle ends the active turn — a
        // stale idle from an interrupt-abandoned turn must not end the next
        // one, and usage flushes inside the end path so it can never land
        // between turns (bughunt round 2: error→idle emitted usage AFTER
        // turn_end and wedged the fleet status "working").
        this.options.onEngineIdle();
        break;
    }
  }

  private statusType(p: Record<string, unknown>): string | undefined {
    const status = p["status"];
    if (typeof status === "object" && status !== null)
      return String((status as Record<string, unknown>)["type"]);
    return undefined;
  }

  private status(state: "thinking" | "tool", label?: string) {
    if (this.lastStatus === state) return;
    this.lastStatus = state;
    this.options.emit({ type: "status", state, ...(label ? { label } : {}) });
  }

  private onMessage(p: Record<string, unknown>) {
    const info = p["info"] as Record<string, unknown> | undefined;
    if (!info || !this.options.isOurs(info["sessionID"] ?? p["sessionID"])) return;
    if (typeof info["role"] === "string") this.roles.set(String(info["id"]), info["role"]);
    if (info["role"] !== "assistant") return;
    const modelID = typeof info["modelID"] === "string" ? info["modelID"] : undefined;
    if (modelID) {
      this.lastModel = modelID;
      this.options.learnModel(modelID);
    }
    const tokens = info["tokens"] as Record<string, unknown> | undefined;
    if (tokens) {
      this.turnUsage.set(String(info["id"]), {
        input: num(tokens["input"]),
        // `reasoning` is reported separately and NOT folded in — mirror of the
        // codex adapter's choice: the status bar counts billed output.
        output: num(tokens["output"]),
        cost: num(info["cost"]),
      });
    }
  }

  /** The turn's one usage message, just before turn_end (protocol contract) —
   *  called by the session's end path, never between turns. */
  flushUsage() {
    if (!this.turnUsage.size) return;
    let input = 0;
    let output = 0;
    let cost = 0;
    for (const t of this.turnUsage.values()) {
      input += t.input;
      output += t.output;
      cost += t.cost;
    }
    this.options.emit({
      type: "usage",
      ...(this.lastModel ? { model: this.lastModel } : {}),
      inputTokens: input,
      outputTokens: output,
      ...(cost > 0 ? { costUsd: cost } : {}),
    });
    this.turnUsage.clear();
  }

  private track(partID: string, kind: PartKind): PartTrack {
    let track = this.parts.get(partID);
    if (!track) {
      track = { kind, emitted: 0 };
      this.parts.set(partID, track);
    }
    return track;
  }

  private onPartSnapshot(p: Record<string, unknown>) {
    const part = p["part"] as Record<string, unknown> | undefined;
    if (!part || !this.options.isOurs(part["sessionID"] ?? p["sessionID"])) return;
    const partID = String(part["id"]);
    const type = String(part["type"]);
    const fromUser = this.roles.get(String(part["messageID"])) === "user";
    switch (type) {
      case "step-start":
        this.status("thinking");
        break;
      case "text":
        if (fromUser) break; // the prompt's own echo — never replayed as output
        this.emitTextSuffix(this.track(partID, "text"), String(part["text"] ?? ""));
        break;
      case "reasoning": {
        if (fromUser) break;
        this.status("thinking");
        const track = this.track(partID, "reasoning");
        // A delta that beat this snapshot registered the part as "text";
        // the snapshot is authoritative — correct the lane for the rest of
        // the stream (bughunt round 2, latent).
        track.kind = "reasoning";
        this.emitTextSuffix(track, String(part["text"] ?? ""));
        break;
      }
      case "tool":
        this.onToolPart(partID, part);
        break;
    }
  }

  private onPartDelta(p: Record<string, unknown>) {
    if (!this.options.isOurs(p["sessionID"])) return;
    if (p["field"] !== "text") return;
    if (this.roles.get(String(p["messageID"])) === "user") return;
    // Deltas can beat the part's first snapshot; an unknown part defaults to
    // text (reasoning parts snapshot before streaming in the OC.0 capture).
    const track = this.track(String(p["partID"]), "text");
    const delta = String(p["delta"] ?? "");
    if (!delta || track.kind === "tool" || track.kind === "other") return;
    track.emitted += delta.length;
    this.emitStreamText(track, delta);
  }

  private emitTextSuffix(track: PartTrack, text: string) {
    if (text.length <= track.emitted) return;
    const suffix = text.slice(track.emitted);
    track.emitted = text.length;
    this.emitStreamText(track, suffix);
  }

  private emitStreamText(track: PartTrack, text: string) {
    this.options.emit({
      type: track.kind === "reasoning" ? "thinking_delta" : "text_delta",
      text,
    });
  }

  private onToolPart(partID: string, part: Record<string, unknown>) {
    const track = this.track(partID, "tool");
    track.kind = "tool";
    const tool = String(part["tool"] ?? "");
    const state = (part["state"] ?? {}) as Record<string, unknown>;
    const status = String(state["status"] ?? "");
    const input = (state["input"] ?? {}) as Record<string, unknown>;
    if (tool.startsWith(MCP_PREFIX)) {
      this.onMirafoldTool(partID, track, tool, state, input);
      return;
    }
    if (status === "running" || status === "completed" || status === "error")
      this.announceTool(track, partID, tool, input);
    if (track.finished) return;
    if (status === "completed") {
      track.finished = true;
      const { text, truncatedBytes } = capOutput(String(state["output"] ?? ""));
      this.options.emit({
        type: "tool_result",
        output: text,
        id: partID,
        ...(truncatedBytes ? { truncatedBytes } : {}),
      });
    } else if (status === "error") {
      track.finished = true;
      // Error text is engine/tool output too — same honest cap as success
      // (ADAPTERS.md: EVERY tool output passes capOutput; bughunt round 2
      // shipped a 200KB error string uncapped into the replay ring).
      const { text, truncatedBytes } = capOutput(String(state["error"] ?? "tool failed"));
      this.options.emit({
        type: "tool_result",
        output: text,
        isError: true,
        id: partID,
        ...(truncatedBytes ? { truncatedBytes } : {}),
      });
    }
  }

  private announceTool(
    track: PartTrack,
    partID: string,
    tool: string,
    input: Record<string, unknown>,
  ) {
    if (track.announced) return;
    track.announced = true;
    this.status("tool", tool);
    this.options.emit({
      type: "tool_use",
      name: tool,
      detail: toolDetail(input),
      id: partID,
      input,
    });
  }

  /** A Mirafold render/artifact call: the stub validated the args and acked
   *  with the component id; the paint happens here, from the part we watched
   *  in the engine's own stream. No raw tool block for the recognized path —
   *  the painting IS its transcript record. */
  private onMirafoldTool(
    partID: string,
    track: PartTrack,
    tool: string,
    state: Record<string, unknown>,
    input: Record<string, unknown>,
  ) {
    const status = String(state["status"] ?? "");
    if (track.finished || (status !== "completed" && status !== "error")) return;
    track.finished = true;
    const renderTool = tool.slice(MCP_PREFIX.length);
    const ackId = RENDER_ID_RE.exec(String(state["output"] ?? ""))?.[1];
    const msg =
      status === "completed" && ackId
        ? generativeUIMsg(renderTool, input, ackId, this.options.workspaceDir)
        : null;
    if (msg) {
      this.options.emit(msg);
      return;
    }
    // Unrecognized render ack or a failed call: fall back to the honest tool
    // record rather than silently dropping what the agent did.
    this.announceTool(track, partID, tool, input);
    const { text, truncatedBytes } = capOutput(String(state["error"] ?? state["output"] ?? ""));
    this.options.emit({
      type: "tool_result",
      output: text,
      ...(status === "error" ? { isError: true as const } : {}),
      id: partID,
      ...(truncatedBytes ? { truncatedBytes } : {}),
    });
  }

  private onTodos(todos: unknown) {
    const list = Array.isArray(todos) ? todos : [];
    // Never paint an empty checklist, but an emptied list must still update
    // one already painted during this turn (same rule as the codex mapper).
    if (!list.length && !this.todoRenderId) return;
    this.todoRenderId ??= randomUUID();
    const items: TodoItem[] = list.map((t) => {
      const todo = (t ?? {}) as Record<string, unknown>;
      const status = String(todo["status"] ?? "pending");
      return {
        content: String(todo["content"] ?? ""),
        status:
          status === "completed" || status === "in_progress"
            ? (status as TodoItem["status"])
            : "pending",
      };
    });
    this.options.emit({
      type: "render",
      component: "todo-list",
      props: { todos: items },
      id: this.todoRenderId,
    });
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Best human text out of a session.error payload without trusting a shape:
 *  {error: {data: {message}}} (observed), {error: {message|name}}, or JSON. */
function sessionErrorText(p: Record<string, unknown>): string {
  const error = p["error"];
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    const data = e["data"];
    if (typeof data === "object" && data !== null) {
      const message = (data as Record<string, unknown>)["message"];
      if (typeof message === "string" && message) return message;
    }
    for (const key of ["message", "name"]) {
      const value = e[key];
      if (typeof value === "string" && value) return value;
    }
  }
  const json = JSON.stringify(error ?? p);
  return json && json !== "{}" ? json.slice(0, 300) : "unknown error";
}
