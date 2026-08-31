import type { SessionMsg } from "../protocol";
import { capOutput, toolDetail, SubagentProseBudget, type TodoItem } from "./types";
import { generativeUIMsg, MIRAFOLD_MCP, renderIdFor } from "./render-mcp-cmd";
import { ChecklistPainter } from "./wire-helpers";
import type { OpenCodeEvent } from "./opencode-client";
import { UnknownKindReporter } from "./wire-helpers";
import { createLogger } from "../log";

const log = createLogger("opencode-events");


// OpenCode advertises MCP tools as `<server>_<tool>` (live capture:
// `mirafold_render_card`), so this prefix is the recognition test.
const MCP_PREFIX = `${MIRAFOLD_MCP}_`;

// Per-turn ceiling on distinct engine parts/messages we track — bloat
// insurance against a hostile or looping engine. A real
// turn has a handful; both maps clear at the next startTurn.
const MAX_PARTS_PER_TURN = 2_000;

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
 * Normalizes the OpenCode event stream (shapes locked by the live capture
 * in opencode.spike.md) into WireMsg. Session-scoped state only;
 * the owning OpenCodeSession supplies turn lifecycle and permission plumbing.
 */
// OpenCode event kinds and part kinds the mapper deliberately does not show;
// anything else it does not handle is reported once per session (TS.7).
export const OPENCODE_IGNORED_EVENTS: Record<string, string> = {
  "server.connected": "transport bookkeeping",
  "server.heartbeat": "transport bookkeeping",
  "installation.updated": "OpenCode self-update bookkeeping",
  "installation.update-available": "OpenCode self-update bookkeeping",
  "session.updated": "metadata the registry derives itself",
  "session.deleted": "lifecycle the session owns",
  "session.diff": "the Changes panel watches the tree itself",
  "session.compacted": "TS.12: surface as the compaction notice",
  "message.removed": "editing bookkeeping",
  "message.part.removed": "editing bookkeeping",
  "file.edited": "the Changes panel watches the tree itself",
  "file.watcher.updated": "the Changes panel watches the tree itself",
  "storage.write": "OpenCode's own persistence",
  "lsp.client.diagnostics": "editor diagnostics not shown in the terminal transcript either",
  "ide.installed": "IDE plumbing",
  "pty.created": "OpenCode's own terminal panes",
  "pty.updated": "OpenCode's own terminal panes",
  "pty.exited": "OpenCode's own terminal panes",
  "pty.deleted": "OpenCode's own terminal panes",
  "vcs.branch.updated": "the status bar reads git itself",
  "command.executed": "slash-command bookkeeping",
  "todo.updated": "handled",
};
export const OPENCODE_HANDLED_EVENTS = [
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "session.status",
  "todo.updated",
  "session.created",
  "permission.asked",
  "permission.replied",
  "session.error",
  "session.idle",
] as const;
export const OPENCODE_HANDLED_PARTS = ["step-start", "text", "reasoning", "tool"] as const;
export const OPENCODE_IGNORED_PARTS: Record<string, string> = {
  "step-finish": "a step boundary; usage arrives on session.idle",
  snapshot: "OpenCode's own undo snapshots",
  "step-start": "handled",
};

export class OpenCodeEventMapper {
  private readonly unknown: UnknownKindReporter;
  private parts = new Map<string, PartTrack>();
  // messageID → role. The stream echoes the USER message's parts exactly like
  // assistant ones (observed live); without this the user's own
  // prompt — guidance prefix included — replays into the transcript as
  // text_delta. message.updated always precedes a message's parts (live
  // captures), so an unknown role is treated as assistant.
  private roles = new Map<string, string>();
  // Per assistant message, latest token/cost report — summed at idle into the
  // turn's one `usage`. Cleared each startTurn so only this turn counts.
  private turnUsage = new Map<string, TurnTokens>();
  private lastModel?: string;
  private lastStatus?: "thinking" | "tool";
  private readonly checklist: ChecklistPainter;
  // The subagent lane: a child session's traffic maps to its spawn's
  // task PART id — the same opaque handle every wire lane groups by. Edges
  // come from the parent task part's state.metadata ({sessionId,
  // parentSessionId} — the join key, lowercase d) and from
  // child `session.created` (Session.parentID), resolved transitively so a
  // user-configured NESTED grandchild lands on its nearest stream-visible
  // ancestor's deck. SESSION-lifetime, not per-turn: a `background: true`
  // child outlives its spawning turn, and clearing these at the next
  // startTurn would make it unroutable — dropping, among other things, its
  // permission ask. The transcript keeps old spawn records, so a late child
  // event routing to a past turn's deck is CORRECT. Growth stays bounded by
  // the insert-time size caps.
  private sessionParents = new Map<string, string>();
  private spawnParts = new Map<string, string>();
  private subagentProse = new SubagentProseBudget();

  constructor(
    private readonly options: {
      emit: (msg: SessionMsg) => void;
      workspaceDir: string;
      /** The ROOT session this mapper narrates. Subagent child sessions
       *  share the event stream under their own ids and ride the subagent
       *  lane: their calls and prose group under the parent task
       *  part's id via `laneOf`, never the top-level transcript. */
      isOurs: (sessionID: unknown) => boolean;
      learnModel: (modelID: string) => void;
      onPermissionAsked: (ask: {
        id: string;
        permission: string;
        detail: string;
        /** Set when the asker is a subagent — the lane's opaque handle. */
        parentId?: string;
      }) => void;
      /** A reply observed on the stream (answered by another client, e.g. a
       *  TUI attached to the same engine session) — not our own echo. */
      onPermissionReplied: (requestID: string, reply: string) => void;
      /** One engine `session.idle` for our session — the SESSION scopes it to
       *  the right turn and flushes usage inside the end path. */
      onEngineIdle: () => void;
      endTurn: () => void;
    },
  ) {
    this.unknown = new UnknownKindReporter(options.emit, "OpenCode", (m) => log.warn(m));
    this.checklist = new ChecklistPainter(options.emit);
  }

  startTurn() {
    this.turnUsage.clear();
    this.lastStatus = undefined;
    // Part/role tracking resets at the NEXT turn's start, not at turn end:
    // the maps otherwise grow unboundedly over a long session, but a
    // straggler snapshot arriving just after idle must
    // still find its track — a fresh default would re-emit its whole text.
    this.parts.clear();
    this.roles.clear();
    // The narration budget is turn-scoped; the lane's session-edge maps are
    // deliberately NOT cleared here — see their declaration (a background
    // child outlives its turn and must stay routable).
    this.subagentProse.clear();
  }

  /** Which lane a session's traffic belongs to: "root" for the session this
   *  mapper narrates; the spawn part id (the opaque wire handle) for a
   *  child, resolved transitively — a configured nested grandchild lands on
   *  its nearest stream-visible ancestor's deck; undefined = unroutable,
   *  skipped whole. */
  private laneOf(sessionID: unknown): "root" | string | undefined {
    if (this.options.isOurs(sessionID)) return "root";
    let cursor = typeof sessionID === "string" ? sessionID : undefined;
    for (let hops = 0; cursor !== undefined && hops < 16; hops++) {
      const parent = this.sessionParents.get(cursor);
      if (parent === undefined) return undefined;
      if (this.options.isOurs(parent)) return this.spawnParts.get(cursor);
      cursor = parent;
    }
    return undefined;
  }

  endTurn() {
    this.checklist.reset();
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
      case "session.created": {
        // A child spawn's session edge. The task part's metadata is
        // what yields the DECK handle; this edge is what makes transitive
        // (grandchild) resolution possible.
        const info = p["info"] as Record<string, unknown> | undefined;
        const id = info?.["id"];
        const parentID = info?.["parentID"];
        if (
          typeof id === "string" &&
          typeof parentID === "string" &&
          this.sessionParents.size < MAX_PARTS_PER_TURN
        )
          this.sessionParents.set(id, parentID);
        break;
      }
      case "permission.asked": {
        // A SUBAGENT's ask surfaces too — dropping child asks whole would
        // leave a gated subagent hung with no UI and no deny timer.
        // Unroutable sessions stay skipped.
        const lane = this.laneOf(p["sessionID"]);
        if (lane === undefined) break;
        const patterns = Array.isArray(p["patterns"]) ? p["patterns"].map(String) : [];
        this.options.onPermissionAsked({
          id: String(p["id"]),
          permission: String(p["permission"] ?? "tool"),
          detail: patterns.join(", ") || String(p["permission"] ?? ""),
          ...(lane !== "root" ? { parentId: lane } : {}),
        });
        break;
      }
      case "permission.replied":
        if (this.laneOf(p["sessionID"]) !== undefined)
          this.options.onPermissionReplied(String(p["requestID"]), String(p["reply"]));
        break;
      case "session.error": {
        // `sessionID` can be absent on transport-level errors; treat those as
        // ours rather than swallow them. A KNOWN child's error is NOT the
        // root turn's death — it surfaces honestly as the spawn part's error
        // result on the parent stream.
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
        // between turns (an error→idle usage emitted AFTER turn_end wedges
        // the fleet status "working").
        this.options.onEngineIdle();
        break;
      default:
        if (!(event.type in OPENCODE_IGNORED_EVENTS)) this.unknown.report("event", event.type);
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
    if (!info) return;
    const lane = this.laneOf(info["sessionID"] ?? p["sessionID"]);
    if (lane === undefined) return;
    // Roles are tracked for CHILD messages too: a child's user-role
    // message is the task prompt, and its parts must never replay as the
    // subagent's own narration — the same echo rule the root obeys.
    if (typeof info["role"] === "string" && this.roles.size < MAX_PARTS_PER_TURN)
      this.roles.set(String(info["id"]), info["role"]);
    // Usage and model stay the ROOT conversation's: the status bar counts
    // the session's own context weight.
    if (lane !== "root") return;
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

  // Per-turn cap on distinct tracked parts: a hostile/looping engine
  // streaming unbounded distinct part ids can't grow this map (or `roles`)
  // without limit within one turn. Beyond the
  // cap a new part is dropped — its text isn't relayed; a real turn never
  // approaches this, so only a flood degrades, and to silence, never to a
  // corrupt shared counter.
  private track(partID: string, kind: PartKind): PartTrack | undefined {
    let track = this.parts.get(partID);
    if (!track) {
      if (this.parts.size >= MAX_PARTS_PER_TURN) return undefined;
      track = { kind, emitted: 0 };
      this.parts.set(partID, track);
    }
    return track;
  }

  private onPartSnapshot(p: Record<string, unknown>) {
    const part = p["part"] as Record<string, unknown> | undefined;
    if (!part) return;
    const lane = this.laneOf(part["sessionID"] ?? p["sessionID"]);
    if (lane === undefined) return;
    const parentId = lane === "root" ? undefined : lane;
    const partID = String(part["id"]);
    const type = String(part["type"]);
    const fromUser = this.roles.get(String(part["messageID"])) === "user";
    switch (type) {
      case "step-start":
        // A child's step boundaries never steer the root activity line.
        if (!parentId) this.status("thinking");
        break;
      case "text": {
        if (fromUser) break; // the prompt's own echo — never replayed as output
        const track = this.track(partID, "text");
        if (track) this.emitTextSuffix(track, String(part["text"] ?? ""), parentId);
        break;
      }
      case "reasoning": {
        if (fromUser) break;
        if (!parentId) this.status("thinking");
        const track = this.track(partID, "reasoning");
        if (!track) break;
        // A delta that beat this snapshot registered the part as "text";
        // the snapshot is authoritative — correct the lane for the rest of
        // the stream.
        track.kind = "reasoning";
        this.emitTextSuffix(track, String(part["text"] ?? ""), parentId);
        break;
      }
      case "tool":
        this.onToolPart(partID, part, parentId);
        break;
      default:
        if (!fromUser && !(type in OPENCODE_IGNORED_PARTS)) this.unknown.report("message part", type);
    }
  }

  private onPartDelta(p: Record<string, unknown>) {
    const lane = this.laneOf(p["sessionID"]);
    if (lane === undefined) return;
    const parentId = lane === "root" ? undefined : lane;
    if (p["field"] !== "text") return;
    if (this.roles.get(String(p["messageID"])) === "user") return;
    // Deltas can beat the part's first snapshot; an unknown part defaults to
    // text (reasoning parts snapshot before streaming in the live capture).
    const track = this.track(String(p["partID"]), "text");
    const delta = String(p["delta"] ?? "");
    if (!track || !delta || track.kind === "tool" || track.kind === "other") return;
    track.emitted += delta.length;
    this.emitStreamText(track, delta, parentId);
  }

  private emitTextSuffix(track: PartTrack, text: string, parentId?: string) {
    if (text.length <= track.emitted) return;
    const suffix = text.slice(track.emitted);
    track.emitted = text.length;
    this.emitStreamText(track, suffix, parentId);
  }

  private emitStreamText(track: PartTrack, text: string, parentId?: string) {
    // A subagent's prose rides its deck's lane, budget-capped (the same
    // per-subagent cap the Claude Code lane applies). `emitted` above
    // tracks SOURCE position either way, so a capped deck still consumes
    // the stream correctly and later suffixes stay aligned.
    const forwarded = parentId ? this.subagentProse.take(parentId, text) : text;
    if (!forwarded) return;
    this.options.emit({
      type: track.kind === "reasoning" ? "thinking_delta" : "text_delta",
      text: forwarded,
      ...(parentId ? { parentId } : {}),
    });
  }

  private onToolPart(partID: string, part: Record<string, unknown>, parentId?: string) {
    const track = this.track(partID, "tool");
    if (!track) return;
    track.kind = "tool";
    const tool = String(part["tool"] ?? "");
    const state = (part["state"] ?? {}) as Record<string, unknown>;
    const status = String(state["status"] ?? "");
    const input = (state["input"] ?? {}) as Record<string, unknown>;
    // A ROOT tool part whose metadata names a spawned session is the
    // deck anchor — record the join (metadata {sessionId, parentSessionId},
    // lowercase d, engine casing verbatim).
    // Read shape-wise, not by tool name, so the lane stays name-agnostic.
    if (!parentId) {
      const meta = state["metadata"] as Record<string, unknown> | undefined;
      const childSession = meta?.["sessionId"];
      const parentSession = meta?.["parentSessionId"];
      if (
        typeof childSession === "string" &&
        typeof parentSession === "string" &&
        this.spawnParts.size < MAX_PARTS_PER_TURN
      ) {
        this.spawnParts.set(childSession, partID);
        this.sessionParents.set(childSession, parentSession);
      }
    }
    if (tool.startsWith(MCP_PREFIX)) {
      // A SUBAGENT's render call does not paint — paintings are session-level
      // chrome, and a card's content is calls + prose. It gets
      // the honest tool record instead, nested in its deck.
      if (!parentId) {
        this.onMirafoldTool(partID, track, tool, state, input);
        return;
      }
    }
    if (status === "running" || status === "completed" || status === "error")
      this.announceTool(track, partID, tool, input, parentId);
    if (track.finished) return;
    if (status === "completed") {
      track.finished = true;
      const { text, truncatedBytes } = capOutput(String(state["output"] ?? ""));
      this.options.emit({
        type: "tool_result",
        output: text,
        id: partID,
        ...(truncatedBytes ? { truncatedBytes } : {}),
        ...(parentId ? { parentId } : {}),
      });
    } else if (status === "error") {
      track.finished = true;
      // Error text is engine/tool output too — same honest cap as success
      // (ADAPTERS.md: EVERY tool output passes capOutput — an uncapped error
      // string would land whole in the replay ring).
      const { text, truncatedBytes } = capOutput(String(state["error"] ?? "tool failed"));
      this.options.emit({
        type: "tool_result",
        output: text,
        isError: true,
        id: partID,
        ...(truncatedBytes ? { truncatedBytes } : {}),
        ...(parentId ? { parentId } : {}),
      });
    }
  }

  private announceTool(
    track: PartTrack,
    partID: string,
    tool: string,
    input: Record<string, unknown>,
    parentId?: string,
  ) {
    if (track.announced) return;
    track.announced = true;
    // A child's tool churn never steers the root activity line.
    if (!parentId) this.status("tool", tool);
    this.options.emit({
      type: "tool_use",
      name: tool,
      detail: toolDetail(input),
      id: partID,
      input,
      ...(parentId ? { parentId } : {}),
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
    const msg =
      status === "completed"
        ? generativeUIMsg(
            renderTool,
            input,
            renderIdFor({ ackText: state["output"], argId: input["id"] }),
            this.options.workspaceDir,
          )
        : null;
    if (msg) {
      this.options.emit(msg);
      return;
    }
    // An unknown render tool or a failed call: fall back to the honest tool
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
    this.checklist.paint(items);
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
