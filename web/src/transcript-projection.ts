import type { ZoneMsg } from "./session-bus";
import { subagentSummary, type SubagentSummary } from "./subagent-deck";
import {
  groupToolActivity,
  type ActivityItem,
  type FoldedActivity,
} from "./tool-visibility";

/**
 * Stateful wire-to-view projection for the output zone. It owns transcript
 * chronology and grouping, while React owns disclosure and the browser edge
 * owns subscription/timing. Callers receive rows that are ready to render.
 */

export type TextRow = {
  kind: "text";
  id: number;
  role: "user" | "assistant";
  text: string;
  done: boolean;
  /** The engine's own classification (text_delta.phase): commentary is
   *  narration, final is the answer. Unset → the length heuristic decides. */
  phase?: "commentary" | "final";
};

export type RenderRow = {
  kind: "render";
  id: number;
  renderId: string;
  component: string;
  props: Record<string, unknown>;
};

export type ArtifactRow = {
  kind: "artifact";
  id: number;
  artifactId: string;
  html: string;
  title?: string;
};

export type PaintingRow = RenderRow | ArtifactRow;

export type ToolRow = {
  kind: "tool";
  id: number;
  toolId: string;
  name: string;
  detail?: string;
  input?: Record<string, unknown>;
  output?: string;
  truncatedBytes?: number;
  parentId?: string;
  isError?: boolean;
  startedAt: number;
  replayed?: boolean;
  /** Output streamed while the call runs (tool_output_delta); `output` is
   *  still the engine's authoritative text once the call completes. */
  streamed?: string;
};

export type SubagentProseRow = {
  kind: "subtext";
  id: number;
  parentId: string;
  variant: "text" | "thinking";
  text: string;
};

export type ThinkingRow = {
  kind: "thinking";
  id: number;
  text: string;
  done: boolean;
};

export type NoticeRow = {
  kind: "notice";
  id: number;
  text: string;
  noticeKind?: string;
  source?: string;
};

export type BangRow = {
  kind: "bang";
  id: number;
  bangId: string;
  command: string;
  output: string;
  exitCode?: number | null;
  done: boolean;
  /** The `!!` form — shell only, the agent never saw it. */
  silent?: true;
};

export type PickerTranscriptRow = {
  kind: "picker";
  id: number;
  pickerId: string;
  title: string;
  rows: { label: string; detail?: string; current?: boolean; text: string }[];
  hint?: string;
  active: boolean;
};

export type ToolFoldItem = FoldedActivity<ToolRow, ThinkingRow, TextRow>;

export type ToolFoldRow = {
  kind: "tool-fold";
  id: number;
  items: ToolFoldItem[];
  actionCount: number;
  summary: string;
  /** The turn that produced these calls is still running ("working" vs
   *  "worked"). */
  live: boolean;
};

/** Narration the fold may absorb between two calls: a short assistant
 *  remark ("Typecheck is clean — running the tests next."), not a paragraph.
 *  Anything longer is a real boundary and stays its own visible row. */
export const NARRATION_MAX_LINES = 2;
export const NARRATION_MAX_CHARS = 160;
export function isShortNarration(row: TextRow): boolean {
  if (row.role !== "assistant") return false;
  // An engine that declares the phase settles it: commentary is narration
  // whatever its length; the answer never folds.
  if (row.phase === "commentary") return row.text.trim().length > 0;
  if (row.phase === "final") return false;
  const text = row.text.trim();
  if (!text) return false;
  const lines = text.split("\n").filter((line) => line.trim()).length;
  return lines <= NARRATION_MAX_LINES && text.length <= NARRATION_MAX_CHARS;
}

export type SubagentDeckRow = {
  kind: "subagent-deck";
  id: number;
  task: ToolRow;
  items: Array<ToolRow | SubagentProseRow>;
  summary: SubagentSummary;
};

export type OutputZoneRow =
  | TextRow
  | RenderRow
  | ArtifactRow
  | ToolRow
  | ThinkingRow
  | NoticeRow
  | BangRow
  | PickerTranscriptRow
  | ToolFoldRow
  | SubagentDeckRow;

export type TranscriptSnapshot = {
  revision: number;
  /** Includes nested prose waiting for its deck anchor, not only visible rows. */
  hasTranscriptContent: boolean;
  rows: readonly OutputZoneRow[];
  /** The values are the exact painting objects present in `rows`. */
  paintingsById: ReadonlyMap<string, PaintingRow>;
};

export type TranscriptTailIntent = "arm-follow" | "reset-tail";

export type TranscriptProjectionResult = {
  snapshot: TranscriptSnapshot;
  tailIntents: readonly TranscriptTailIntent[];
};

export interface TranscriptProjection {
  apply(messages: readonly ZoneMsg[], readNow: () => number): TranscriptProjectionResult;
}

type ToolEntry = ToolRow & {
  batchId: number;
  settled: boolean;
};

type PickerEntry = Omit<PickerTranscriptRow, "active">;

type TranscriptEntry =
  | TextRow
  | RenderRow
  | ArtifactRow
  | ToolEntry
  | SubagentProseRow
  | ThinkingRow
  | NoticeRow
  | BangRow
  | PickerEntry;

let nextTranscriptId = 0;
const toolRowCache = new WeakMap<ToolEntry, ToolRow>();

function visibleToolRow(entry: ToolEntry): ToolRow {
  const cached = toolRowCache.get(entry);
  if (cached) return cached;
  const { batchId, settled, ...row } = entry;
  void batchId;
  void settled;
  toolRowCache.set(entry, row);
  return row;
}

const sameReferences = <T>(left: readonly T[], right: readonly T[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

const sameFoldItems = (
  left: readonly ToolFoldItem[],
  right: readonly ToolFoldItem[],
): boolean =>
  left.length === right.length &&
  left.every((item, index) => {
    const other = right[index];
    if (!other || item.kind !== other.kind) return false;
    return item.kind === "tool"
      ? item.tool === (other as Extract<ToolFoldItem, { kind: "tool" }>).tool
      : item.kind === "thinking"
        ? item.thinking === (other as Extract<ToolFoldItem, { kind: "thinking" }>).thinking
        : item.text === (other as Extract<ToolFoldItem, { kind: "text" }>).text;
  });

const sameDeckItems = (
  left: readonly (ToolRow | SubagentProseRow)[],
  right: readonly (ToolRow | SubagentProseRow)[],
): boolean => sameReferences(left, right);

function toolFoldRow(
  id: number,
  items: ToolFoldItem[],
  live: boolean,
  previous: OutputZoneRow | undefined,
): ToolFoldRow {
  if (
    previous?.kind === "tool-fold" &&
    previous.live === live &&
    sameFoldItems(previous.items, items)
  ) {
    return previous;
  }
  const calls = items.flatMap((item) => (item.kind === "tool" ? [item.tool] : []));
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  const summary = [...counts]
    .slice(0, 3)
    .map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ""}`)
    .join(" · ");
  return { kind: "tool-fold", id, items, actionCount: calls.length, summary, live };
}

function subagentDeckRow(
  task: ToolEntry,
  items: Array<ToolEntry | SubagentProseRow>,
  previous: OutputZoneRow | undefined,
): SubagentDeckRow {
  const taskRow = visibleToolRow(task);
  const visibleItems = items.map((item) =>
    item.kind === "tool" ? visibleToolRow(item) : item,
  );
  if (
    previous?.kind === "subagent-deck" &&
    previous.task === taskRow &&
    sameDeckItems(previous.items, visibleItems)
  ) {
    return previous;
  }
  const calls = items.filter((item): item is ToolEntry => item.kind === "tool");
  return {
    kind: "subagent-deck",
    id: task.id,
    task: taskRow,
    items: visibleItems,
    summary: subagentSummary(task, calls),
  };
}

function pickerRow(
  entry: PickerEntry,
  active: boolean,
  previous: OutputZoneRow | undefined,
): PickerTranscriptRow {
  if (
    previous?.kind === "picker" &&
    previous.pickerId === entry.pickerId &&
    previous.title === entry.title &&
    previous.rows === entry.rows &&
    previous.hint === entry.hint &&
    previous.active === active
  ) {
    return previous;
  }
  return { ...entry, active };
}

function buildSnapshot(
  entries: readonly TranscriptEntry[],
  previous: TranscriptSnapshot,
): TranscriptSnapshot {
  const previousById = new Map(previous.rows.map((row) => [row.id, row]));
  const cardItemsByParent = new Map<string, Array<ToolEntry | SubagentProseRow>>();
  for (const entry of entries) {
    if ((entry.kind !== "tool" && entry.kind !== "subtext") || !entry.parentId) continue;
    if (entry.kind === "tool" && entry.isError) continue;
    const items = cardItemsByParent.get(entry.parentId) ?? [];
    items.push(entry);
    cardItemsByParent.set(entry.parentId, items);
  }

  const compactedTools = groupToolActivity(
    entries.flatMap((entry): Array<ActivityItem<ToolEntry, ThinkingRow, TextRow>> =>
      entry.kind === "tool"
        ? entry.parentId && !entry.isError
          ? []
          : cardItemsByParent.has(entry.toolId)
            ? [null]
            : [{ kind: "tool", tool: entry }]
        : entry.kind === "thinking"
          ? [{ kind: "thinking", thinking: entry }]
          : entry.kind === "text" && isShortNarration(entry)
            ? [{ kind: "text", text: entry }]
            : entry.kind === "subtext"
              ? []
              : [null],
    ),
  );

  let activePickerId: number | null = null;
  for (const entry of entries) {
    if (entry.kind === "picker") activePickerId = entry.id;
    else if (entry.kind === "text" && entry.role === "user") activePickerId = null;
  }

  const rows: OutputZoneRow[] = [];
  for (const entry of entries) {
    if (entry.kind === "subtext") continue;
    if (entry.kind === "thinking" || entry.kind === "text") {
      if (!compactedTools.hidden.has(entry.id)) rows.push(entry);
      continue;
    }
    if (entry.kind === "tool") {
      const compacted = compactedTools.anchors.get(entry.id);
      if (compacted) {
        const visibleItems: ToolFoldItem[] = compacted.map((item) =>
          item.kind === "tool"
            ? { kind: "tool", tool: visibleToolRow(item.tool) }
            : item,
        );
        const live = compacted.some((item) => item.kind === "tool" && !item.tool.settled);
        rows.push(toolFoldRow(entry.id, visibleItems, live, previousById.get(entry.id)));
        continue;
      }
      if (compactedTools.hidden.has(entry.id)) continue;
      if (entry.parentId && !entry.isError) continue;
      const items = cardItemsByParent.get(entry.toolId);
      if (items?.length) {
        rows.push(subagentDeckRow(entry, items, previousById.get(entry.id)));
      } else {
        rows.push(visibleToolRow(entry));
      }
      continue;
    }
    if (entry.kind === "picker") {
      rows.push(pickerRow(entry, entry.id === activePickerId, previousById.get(entry.id)));
      continue;
    }
    rows.push(entry);
  }

  const stableRows = sameReferences(previous.rows, rows) ? previous.rows : rows;
  const paintingsById = new Map<string, PaintingRow>();
  for (const row of stableRows) {
    const paintingId =
      row.kind === "render"
        ? row.renderId
        : row.kind === "artifact"
          ? row.artifactId
          : undefined;
    // A cross-kind wire-id collision binds to the first painting in
    // transcript order (first wins, as Array.find() would).
    if (paintingId !== undefined && !paintingsById.has(paintingId)) {
      paintingsById.set(paintingId, row as PaintingRow);
    }
  }
  const samePaintings =
    paintingsById.size === previous.paintingsById.size &&
    [...paintingsById].every(([id, painting]) => previous.paintingsById.get(id) === painting);

  return {
    revision: previous.revision + 1,
    hasTranscriptContent: entries.length > 0,
    rows: stableRows,
    paintingsById: samePaintings ? previous.paintingsById : paintingsById,
  };
}

export function createTranscriptProjection(): TranscriptProjection {
  let entries: TranscriptEntry[] = [];
  let streamingId: number | null = null;
  // The phase the open prose row was started with (text_delta.phase); a
  // delta declaring a different phase closes the row and opens a new one.
  let streamingPhase: "commentary" | "final" | undefined;
  let thinkingId: number | null = null;
  const subtextIds = new Map<string, number>();
  let openToolBatches: number[] = [];
  let orphanToolBatch = -1;
  let snapshot: TranscriptSnapshot = {
    revision: 0,
    hasTranscriptContent: false,
    rows: [],
    paintingsById: new Map(),
  };

  const foldThinking = (): boolean => {
    const id = thinkingId;
    if (id === null) return false;
    thinkingId = null;
    entries = entries.map((entry) =>
      entry.kind === "thinking" && entry.id === id ? { ...entry, done: true } : entry,
    );
    return true;
  };

  const applyMessage = (
    msg: ZoneMsg,
    readNow: () => number,
    tailIntents: TranscriptTailIntent[],
  ): boolean => {
    // Child prose routes before the root-stream boundary logic: a subagent
    // must not close or fold its parent's currently streaming output.
    if ((msg.type === "text_delta" || msg.type === "thinking_delta") && msg.parentId) {
      const variant = msg.type === "text_delta" ? "text" : "thinking";
      const key = `${msg.parentId}|${variant}`;
      const openId = subtextIds.get(key);
      if (openId !== undefined) {
        entries = entries.map((entry) =>
          entry.kind === "subtext" && entry.id === openId
            ? { ...entry, text: entry.text + msg.text }
            : entry,
        );
      } else {
        const id = nextTranscriptId++;
        subtextIds.set(key, id);
        entries = [
          ...entries,
          {
            kind: "subtext",
            id,
            parentId: msg.parentId,
            variant,
            text: msg.text,
          },
        ];
      }
      return true;
    }

    let changed = false;
    // Thinking folds only when the turn's real output begins. Notices, errors,
    // bang commands, and shell-only frames deliberately do not trigger it.
    if (
      msg.type === "text_delta" ||
      msg.type === "render" ||
      msg.type === "picker" ||
      msg.type === "tool_use" ||
      msg.type === "artifact" ||
      msg.type === "turn_end"
    ) {
      changed = foldThinking();
    }

    switch (msg.type) {
      case "user_prompt": {
        tailIntents.push("arm-follow");
        const id = nextTranscriptId++;
        openToolBatches.push(id);
        entries = [...entries, { kind: "text", id, role: "user", text: msg.text, done: true }];
        return true;
      }
      case "thinking_delta": {
        if (thinkingId !== null) {
          const id = thinkingId;
          entries = entries.map((entry) =>
            entry.kind === "thinking" && entry.id === id
              ? { ...entry, text: entry.text + msg.text }
              : entry,
          );
        } else {
          const id = nextTranscriptId++;
          thinkingId = id;
          entries = [...entries, { kind: "thinking", id, text: msg.text, done: false }];
        }
        return true;
      }
      case "text_delta": {
        // A phase change (commentary → final answer) starts a new row so the
        // narration and the answer never share one block.
        if (streamingId !== null && msg.phase !== undefined && msg.phase !== streamingPhase) {
          const closing = streamingId;
          entries = entries.map((entry) => (entry.id === closing ? { ...entry, done: true } : entry));
          streamingId = null;
        }
        if (streamingId !== null) {
          const id = streamingId;
          entries = entries.map((entry) =>
            entry.kind === "text" && entry.id === id
              ? { ...entry, text: entry.text + msg.text }
              : entry,
          );
        } else {
          const id = nextTranscriptId++;
          streamingId = id;
          streamingPhase = msg.phase;
          entries = [
            ...entries,
            { kind: "text", id, role: "assistant", text: msg.text, done: false, ...(msg.phase ? { phase: msg.phase } : {}) },
          ];
        }
        return true;
      }
      case "render": {
        streamingId = null;
        const id = nextTranscriptId++;
        const index = entries.findIndex(
          (entry) => entry.kind === "render" && entry.renderId === msg.id,
        );
        if (index >= 0) {
          const updated = [...entries];
          updated[index] = {
            ...(updated[index] as RenderRow),
            component: msg.component,
            props: msg.props,
          };
          entries = updated;
        } else {
          entries = [
            ...entries,
            {
              kind: "render",
              id,
              renderId: msg.id,
              component: msg.component,
              props: msg.props,
            },
          ];
        }
        return true;
      }
      case "picker": {
        streamingId = null;
        entries = [
          ...entries,
          {
            kind: "picker",
            id: nextTranscriptId++,
            pickerId: msg.id,
            title: msg.title,
            rows: msg.rows,
            hint: msg.hint,
          },
        ];
        return true;
      }
      case "artifact": {
        streamingId = null;
        const id = nextTranscriptId++;
        const index = entries.findIndex(
          (entry) => entry.kind === "artifact" && entry.artifactId === msg.id,
        );
        if (index >= 0) {
          const updated = [...entries];
          updated[index] = {
            ...(updated[index] as ArtifactRow),
            html: msg.html,
            title: msg.title,
          };
          entries = updated;
        } else {
          entries = [
            ...entries,
            {
              kind: "artifact",
              id,
              artifactId: msg.id,
              html: msg.html,
              title: msg.title,
            },
          ];
        }
        return true;
      }
      case "tool_use": {
        streamingId = null;
        // A child tool splits that child's prose chronology, so prose after
        // the call opens below it instead of extending the earlier row.
        if (msg.parentId) {
          subtextIds.delete(`${msg.parentId}|text`);
          subtextIds.delete(`${msg.parentId}|thinking`);
        }
        // Prompts may queue while a turn is live; tools still belong to the
        // oldest open turn, hence FIFO rather than "most recent prompt".
        const batchId = openToolBatches[0] ?? orphanToolBatch;
        entries = [
          ...entries,
          {
            kind: "tool",
            id: nextTranscriptId++,
            toolId: msg.id,
            name: msg.name,
            detail: msg.detail,
            input: msg.input,
            parentId: msg.parentId,
            batchId,
            settled: false,
            startedAt: readNow(),
            ...(msg.replay ? { replayed: true } : {}),
          },
        ];
        return true;
      }
      case "tool_update": {
        entries = entries.map((entry) =>
          entry.kind === "tool" && entry.toolId === msg.id && entry.output === undefined
            ? {
                ...entry,
                ...(msg.detail !== undefined ? { detail: msg.detail } : {}),
                ...(msg.input !== undefined ? { input: msg.input } : {}),
              }
            : entry,
        );
        return true;
      }
      case "tool_output_delta": {
        entries = entries.map((entry) =>
          entry.kind === "tool" && entry.toolId === msg.id && entry.output === undefined
            ? { ...entry, streamed: (entry.streamed ?? "") + msg.text }
            : entry,
        );
        return true;
      }
      case "tool_result": {
        entries = entries.map((entry) =>
          entry.kind === "tool" && entry.toolId === msg.id
            ? {
                ...entry,
                output: msg.output,
                // The authoritative output subsumes the streamed copy —
                // release it (PR #80 review).
                streamed: undefined,
                truncatedBytes: msg.truncatedBytes,
                isError: msg.isError,
              }
            : entry,
        );
        return true;
      }
      case "turn_end": {
        const id = streamingId;
        streamingId = null;
        subtextIds.clear();
        const batchId = openToolBatches.shift() ?? orphanToolBatch--;
        entries = entries.map((entry) => {
          if (entry.kind === "text" && entry.id === id) return { ...entry, done: true };
          if (entry.kind === "tool" && entry.batchId === batchId) {
            return {
              ...entry,
              settled: true,
              // A pending call at turn end was interrupted. Keep it expanded
              // and explicit instead of folding it as successful activity —
              // and keep the output observed before the stop; the streamed
              // copy is released either way (PR #80 review).
              ...(entry.output === undefined
                ? {
                    output: entry.streamed
                      ? `${entry.streamed}\n(interrupted — no result)`
                      : "(interrupted — no result)",
                    isError: true,
                  }
                : {}),
              streamed: undefined,
            };
          }
          return entry;
        });
        return true;
      }
      case "error": {
        streamingId = null;
        entries = [
          ...entries,
          {
            kind: "text",
            id: nextTranscriptId++,
            role: "assistant",
            text: `**Error:** ${msg.message}`,
            done: true,
          },
        ];
        return true;
      }
      case "notice": {
        // A notice is a status aside in transcript order. It leaves both the
        // root text stream and open thinking state untouched.
        entries = [
          ...entries,
          {
            kind: "notice",
            id: nextTranscriptId++,
            text: msg.text,
            noticeKind: msg.kind,
            source: msg.source,
          },
        ];
        return true;
      }
      case "bang_start": {
        streamingId = null;
        entries = [
          ...entries,
          {
            kind: "bang",
            id: nextTranscriptId++,
            bangId: msg.id,
            command: msg.command,
            output: "",
            done: false,
            ...(msg.silent ? { silent: true as const } : {}),
          },
        ];
        return true;
      }
      case "bang_output": {
        entries = entries.map((entry) =>
          entry.kind === "bang" && entry.bangId === msg.id
            ? { ...entry, output: entry.output + msg.data }
            : entry,
        );
        return true;
      }
      case "bang_end": {
        entries = entries.map((entry) =>
          entry.kind === "bang" && entry.bangId === msg.id
            ? { ...entry, exitCode: msg.exitCode, done: true }
            : entry,
        );
        return true;
      }
      case "zone_reset": {
        streamingId = null;
        thinkingId = null;
        // Stale parent/variant cursors would append replay into ids that were
        // removed by this reset rather than creating fresh replay rows.
        subtextIds.clear();
        openToolBatches = [];
        orphanToolBatch = -1;
        tailIntents.push("reset-tail");
        entries = [];
        return true;
      }

      // Shell state, connection plumbing, and per-viewport request replies do
      // not create output-zone rows. Listing every arm keeps additions to the
      // wire union reviewable at compile time; a runtime-unknown arm still
      // reaches the inert default below for version-skew compatibility.
      case "prompt_options":
      case "status":
      case "permission_request":
      case "permission_resolved":
      case "session_created":
      case "shell_cwd":
      case "agents":
      case "folder_picked":
      case "subscription":
      case "entitlement":
      case "refused":
      case "usage":
      case "fs_tree":
      case "fs_dir":
      case "fs_file":
      case "fs_file_diff":
      case "fs_change_set":
      case "fs_changed":
      case "file_upload_done":
      case "file_upload_error":
      case "pong":
      case "sessions":
      case "session_ended":
        return changed;
      default: {
        const exhaustive: never = msg;
        void exhaustive;
        return changed;
      }
    }
  };

  return {
    apply(messages, readNow) {
      const tailIntents: TranscriptTailIntent[] = [];
      let changed = false;
      for (const message of messages) {
        if (applyMessage(message, readNow, tailIntents)) changed = true;
      }
      if (changed) snapshot = buildSnapshot(entries, snapshot);
      return { snapshot, tailIntents };
    },
  };
}
