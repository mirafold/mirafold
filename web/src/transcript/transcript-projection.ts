import type { ToolAction } from "@protocol";
import type { ZoneMsg } from "../transport/session-bus";
import { subagentSummary, type SubagentSummary, type TaskLifecycle } from "./subagent-deck";
import {
  groupToolActivity,
  type ActivityItem,
  type FoldedActivity,
} from "./tool-visibility";

export type { TaskLifecycle } from "./subagent-deck";

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

/** The latest bounded replacement snapshot of a running call's output
 *  (tool_output_snapshot): a fixed head, the newest tail, and how much fell
 *  between them. Authoritative over the legacy `streamed` prefix. */
export type LiveOutputView = {
  head: string;
  tail?: string;
  omittedBytes?: number;
  revision: number;
};

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
  /** For a subagent's call: the parent task's attempt it belongs to. */
  attempt?: number;
  /** Output streamed while the call runs (tool_output_delta); `output` is
   *  still the engine's authoritative text once the call completes. */
  streamed?: string;
  /** The newest replacement snapshot while the call runs (Phase TF). */
  live?: LiveOutputView;
  /** The engine's verified read/list/search classification (tool_use.actions). */
  actions?: ToolAction[];
  /** The retained tail of a large result and the middle dropped before it. */
  tail?: string;
  omittedBytes?: number;
  /** The command's own exit status, a fact independent of `isError`. */
  exitCode?: number;
  durationMs?: number;
  /** The engine's own running clock for the call (tool_update.elapsedMs). */
  elapsedMs?: number;
  /** A task anchor the engine reported (task_update) with no announcing
   *  call of its own — a background job, or a spawn evicted from replay. */
  synthetic?: boolean;
  /** A result whose announcing call was never retained (evicted before this
   *  viewport attached): shown as an explicit record, never dropped. */
  orphaned?: boolean;
};

export type SubagentProseRow = {
  kind: "subtext";
  id: number;
  parentId: string;
  variant: "text" | "thinking";
  text: string;
  /** Its anchor row was still absent when its turn ended — the row was
   *  evicted from the replay ring before this viewport attached. */
  orphaned?: boolean;
};

export type ThinkingRow = {
  kind: "thinking";
  id: number;
  text: string;
  done: boolean;
  /** Stable across replay: the wire seq of the row's first delta when the
   *  daemon stamped one, else the transcript id — what disclosure keys on. */
  wireKey: string;
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

export type ToolFoldItem = FoldedActivity<ToolRow, ThinkingRow>;

export type ToolFoldRow = {
  kind: "tool-fold";
  id: number;
  items: ToolFoldItem[];
  actionCount: number;
  /** "Read 8 files · 3 searches" — counts by the engine's classification. */
  summary: string;
  /** A bounded selection of the paths/queries the engine named. */
  targets: string[];
  /** The turn that produced these calls is still running ("working" vs
   *  "worked"). */
  live: boolean;
};

/** How many named targets a group's row shows before "…". */
export const FOLD_TARGET_LIMIT = 4;

export type SubagentDeckRow = {
  kind: "subagent-deck";
  id: number;
  task: ToolRow;
  items: Array<ToolRow | SubagentProseRow>;
  summary: SubagentSummary;
  /** The engine's lifecycle word for the task, when it gave one. */
  lifecycle?: TaskLifecycle;
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
      : item.thinking === (other as Extract<ToolFoldItem, { kind: "thinking" }>).thinking;
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
  const { summary, targets } = describeRoutineWork(calls.flatMap((call) => call.actions ?? []));
  return { kind: "tool-fold", id, items, actionCount: calls.length, summary, targets, live };
}

/** "Read 8 files · 3 searches · 2 listings", from the engine's own
 *  classification of each call — never from tool names or command text —
 *  plus a bounded selection of the targets it named. */
export function describeRoutineWork(actions: readonly ToolAction[]): { summary: string; targets: string[] } {
  const counts = { read: 0, search: 0, list: 0 };
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    counts[action.kind] += 1;
    if (action.target && !seen.has(action.target)) {
      seen.add(action.target);
      if (targets.length < FOLD_TARGET_LIMIT) targets.push(action.target);
    }
  }
  const parts: string[] = [];
  if (counts.read) parts.push(`Read ${counts.read} ${counts.read === 1 ? "file" : "files"}`);
  if (counts.search) parts.push(`${counts.search} ${counts.search === 1 ? "search" : "searches"}`);
  if (counts.list) parts.push(`${counts.list} ${counts.list === 1 ? "listing" : "listings"}`);
  return { summary: parts.join(" · "), targets };
}

function subagentDeckRow(
  task: ToolEntry,
  items: Array<ToolEntry | SubagentProseRow>,
  lifecycle: TaskLifecycle | undefined,
  previous: OutputZoneRow | undefined,
): SubagentDeckRow {
  const taskRow = visibleToolRow(task);
  const visibleItems = items.map((item) =>
    item.kind === "tool" ? visibleToolRow(item) : item,
  );
  if (
    previous?.kind === "subagent-deck" &&
    previous.task === taskRow &&
    previous.lifecycle === lifecycle &&
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
    summary: subagentSummary(task, calls, lifecycle),
    ...(lifecycle ? { lifecycle } : {}),
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

// A subagent's reasoning stays reasoning (collapsed, never the assistant's
// voice); its narration reads as commentary.
const orphanNarration = (entry: SubagentProseRow): TextRow | ThinkingRow =>
  entry.variant === "thinking"
    ? { kind: "thinking", id: entry.id, text: entry.text, done: true, wireKey: `orphan:${entry.id}` }
    : { kind: "text", id: entry.id, role: "assistant", text: entry.text, done: true, phase: "commentary" };

/** At a turn's end, narration whose anchor row is still absent is never
 *  getting one (evicted before this viewport attached): mark it orphaned so
 *  the snapshot narrates it inline. Entries already anchored are untouched. */
function orphanAnchorless(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const anchoredToolIds = new Set(entries.flatMap((entry) => (entry.kind === "tool" ? [entry.toolId] : [])));
  return entries.map((entry) =>
    entry.kind === "subtext" && !entry.orphaned && !anchoredToolIds.has(entry.parentId)
      ? { ...entry, orphaned: true }
      : entry,
  );
}

/** What an interrupted call keeps as its result: the observed live output
 *  (the snapshot's head and tail, or the legacy prefix) plus the honest
 *  note that no result ever came. */
function interruptedOutcome(entry: ToolEntry): Pick<ToolRow, "output" | "tail" | "omittedBytes"> {
  const note = "(interrupted — no result)";
  if (entry.live) {
    return {
      output: entry.live.head,
      tail: `${entry.live.tail ?? ""}${entry.live.tail || entry.live.head ? "\n" : ""}${note}`,
      ...(entry.live.omittedBytes !== undefined ? { omittedBytes: entry.live.omittedBytes } : {}),
    };
  }
  return { output: entry.streamed ? `${entry.streamed}\n${note}` : note };
}

function buildSnapshot(
  entries: readonly TranscriptEntry[],
  tasks: ReadonlyMap<string, TaskLifecycle>,
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
  // A deck is any call other records group under OR the engine reported a
  // task lifecycle for — a spawn whose child never called a tool is still a
  // task with a state and a report.
  const isDeck = (entry: ToolEntry) => cardItemsByParent.has(entry.toolId) || tasks.has(entry.toolId);
  // A child row nests only under a parent that EXISTS; an orphaned outcome
  // whose parent anchor was evicted too has no deck to live in and shows at
  // the root instead of nowhere (PR #120 round 5).
  const anchorIds = new Set(entries.flatMap((entry) => (entry.kind === "tool" ? [entry.toolId] : [])));
  const nested = (entry: ToolEntry) => Boolean(entry.parentId) && !entry.isError && anchorIds.has(entry.parentId!);

  const compactedTools = groupToolActivity(
    entries.flatMap((entry): Array<ActivityItem<ToolEntry, ThinkingRow>> =>
      entry.kind === "tool"
        ? nested(entry)
          ? []
          : isDeck(entry)
            ? [null]
            : [{ kind: "tool", tool: entry }]
        : entry.kind === "thinking"
          ? [{ kind: "thinking", thinking: entry }]
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
    if (entry.kind === "subtext") {
      // Anchorless when its turn ended: the anchor is never coming (evicted
      // from the replay ring before attach) — narrate inline rather than
      // nowhere. Before the turn ends it stays hidden, since an anchor may
      // still be on its way.
      if (entry.orphaned) {
        const prev = previousById.get(entry.id);
        rows.push(prev && (prev.kind === "text" || prev.kind === "thinking") && prev.text === entry.text ? prev : orphanNarration(entry));
      }
      continue;
    }
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
      if (nested(entry)) continue;
      const items = cardItemsByParent.get(entry.toolId);
      const lifecycle = tasks.get(entry.toolId);
      if (items?.length || lifecycle) {
        rows.push(subagentDeckRow(entry, items ?? [], lifecycle, previousById.get(entry.id)));
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

/** A result-side message that arrived for a call this viewport never saw
 *  announced: held until the turn (or the replay) closes, then shown as an
 *  explicit record rather than dropped — its start was evicted, not its
 *  outcome. */
type PendingOrphan = {
  output?: string;
  tail?: string;
  omittedBytes?: number;
  truncatedBytes?: number;
  isError?: boolean;
  exitCode?: number;
  durationMs?: number;
  live?: LiveOutputView;
  parentId?: string;
  replayed: boolean;
};

export const EVICTED_HISTORY_NOTICE =
  "Earlier history is no longer retained — the daemon keeps a bounded replay, and this session's oldest messages have fallen off it.";
export const ORPHAN_CALL_NAME = "(earlier call)";
export const ORPHAN_CALL_DETAIL = "its start was not retained";
/** A `!` command whose start fell out of the bounded history while it was
 *  still running: its output must still land somewhere a reader can see. */
export const ORPHAN_BANG_COMMAND = "(earlier command — its start was not retained)";

export function createTranscriptProjection(): TranscriptProjection {
  let entries: TranscriptEntry[] = [];
  let tasks = new Map<string, TaskLifecycle>();
  let orphans = new Map<string, PendingOrphan>();
  // The `!` command the daemon reported running at attach (session_created
  // .bang): the authoritative command and silent flag for a row whose start
  // the bounded history no longer holds.
  let attachBang: { id: string; command: string; silent?: true } | null = null;
  // Bounded like every other per-session ledger: a hostile stream minting
  // results for unknown ids must not grow memory without limit.
  const MAX_PENDING_ORPHANS = 500;
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

  const toolEntry = (toolId: string): ToolEntry | undefined =>
    entries.find((entry): entry is ToolEntry => entry.kind === "tool" && entry.toolId === toolId);

  /** Results for calls never announced become explicit rows once nothing
   *  more can arrive for them (turn end, replay end). They go at the TOP,
   *  after any eviction notice: an outcome whose opening is missing is
   *  older than everything retained, so placing it below the newest turn
   *  would reorder the transcript (review 2026-09-15). */
  const materializeOrphans = (readNow: () => number, terminal: boolean): boolean => {
    if (!orphans.size) return false;
    const batchId = orphanToolBatch;
    const rows: ToolEntry[] = [];
    for (const [toolId, pending] of orphans) {
      const existing = toolEntry(toolId);
      if (existing) {
        // The anchor arrived after the outcome (a task placeholder): the
        // outcome settles it rather than vanishing (PR #120 review).
        if (existing.output === undefined && pending.output !== undefined) {
          entries = entries.map((entry) =>
            entry.kind === "tool" && entry.toolId === toolId
              ? {
                  ...entry,
                  settled: true,
                  output: pending.output,
                  ...(pending.tail !== undefined ? { tail: pending.tail } : {}),
                  ...(pending.omittedBytes !== undefined ? { omittedBytes: pending.omittedBytes } : {}),
                  ...(pending.truncatedBytes !== undefined ? { truncatedBytes: pending.truncatedBytes } : {}),
                  isError: pending.isError,
                  ...(pending.exitCode !== undefined ? { exitCode: pending.exitCode } : {}),
                  ...(pending.durationMs !== undefined ? { durationMs: pending.durationMs } : {}),
                  live: undefined,
                }
              : entry,
          );
        }
        continue;
      }
      rows.push(
        {
          kind: "tool",
          id: nextTranscriptId++,
          toolId,
          name: ORPHAN_CALL_NAME,
          detail: ORPHAN_CALL_DETAIL,
          parentId: pending.parentId,
          batchId,
          settled: terminal || pending.output !== undefined,
          startedAt: readNow(),
          orphaned: true,
          ...(pending.replayed ? { replayed: true } : {}),
          ...(pending.output !== undefined
            ? {
                output: pending.output,
                ...(pending.tail !== undefined ? { tail: pending.tail } : {}),
                ...(pending.omittedBytes !== undefined ? { omittedBytes: pending.omittedBytes } : {}),
                ...(pending.truncatedBytes !== undefined ? { truncatedBytes: pending.truncatedBytes } : {}),
                isError: pending.isError,
                ...(pending.exitCode !== undefined ? { exitCode: pending.exitCode } : {}),
                ...(pending.durationMs !== undefined ? { durationMs: pending.durationMs } : {}),
              }
            : pending.live && !terminal
              ? // Replay end is a delivery boundary, not the call's end: a
                // live-only orphan keeps RUNNING so later snapshots and the
                // real result still land on it (round 3).
                { live: pending.live }
              : pending.live
                ? { ...interruptedOutcome({ live: pending.live } as ToolEntry), isError: true }
                : { output: "(no result was retained)", isError: true }),
        },
      );
    }
    if (rows.length) {
      const noticeCount = entries.findIndex((entry) => !(entry.kind === "notice" && entry.text === EVICTED_HISTORY_NOTICE));
      const at = noticeCount < 0 ? entries.length : noticeCount;
      entries = [...entries.slice(0, at), ...rows, ...entries.slice(at)];
    }
    orphans = new Map();
    return true;
  };

  const rememberOrphan = (toolId: string, patch: Partial<PendingOrphan>, replayed: boolean) => {
    const prior = orphans.get(toolId);
    if (!prior && orphans.size >= MAX_PENDING_ORPHANS) return;
    orphans.set(toolId, { ...(prior ?? { replayed }), ...patch, replayed: (prior?.replayed ?? replayed) && replayed });
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

  /** The terminal part of a turn's end, shared by `turn_end` and a terminal
   *  `error` (the adapter-crash path ends the turn WITHOUT a turn_end —
   *  release review 0.10.0): the open prose row is done, the turn's tool
   *  batch settles (in-flight calls interrupted, a still-running task's
   *  calls left alone), and outcomes for calls never announced get their
   *  rows. A turn_end trailing the error shifts an empty batch list into a
   *  fresh orphan batch nothing is filed under, so it changes nothing. */
  const settleTurn = (readNow: () => number) => {
    const id = streamingId;
    streamingId = null;
    subtextIds.clear();
    const batchId = openToolBatches.shift() ?? orphanToolBatch--;
    const childParents = new Set(
      entries.flatMap((entry) => (entry.kind === "tool" || entry.kind === "subtext") && entry.parentId ? [entry.parentId] : []),
    );
    entries = orphanAnchorless(entries).map((entry) => {
      if (entry.kind === "text" && entry.id === id) return { ...entry, done: true };
      if (entry.kind === "tool" && entry.batchId === batchId) {
        // A child call of a task the engine still reports running is
        // cross-turn activity: the root's turn end says nothing about
        // it (round 3).
        if (entry.parentId && entry.output === undefined && tasks.get(entry.parentId)?.state === "running") return entry;
        const isTask = tasks.has(entry.toolId) || childParents.has(entry.toolId);
        if (isTask && entry.output === undefined) {
          // A task outlives its call's turn by design (a background job,
          // a child still working): turn_end must not call it
          // interrupted or successful. Without ANY engine word on it,
          // its state is honestly unknown.
          if (!tasks.has(entry.toolId)) tasks = new Map(tasks).set(entry.toolId, { state: "unknown" });
          return { ...entry, settled: true, streamed: undefined, live: undefined };
        }
        return {
          ...entry,
          settled: true,
          // A pending call at turn end was interrupted. Keep it expanded
          // and explicit instead of folding it as successful activity —
          // and keep the output observed before the stop; the streamed
          // copy is released either way (PR #80 review).
          ...(entry.output === undefined
            ? {
                ...interruptedOutcome(entry),
                isError: true,
              }
            : {}),
          streamed: undefined,
          live: undefined,
        };
      }
      return entry;
    });
    materializeOrphans(readNow, true);
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
          const wireKey = msg.seq !== undefined ? `seq:${msg.seq}` : `local:${id}`;
          entries = [...entries, { kind: "thinking", id, text: msg.text, done: false, wireKey }];
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
        // A task the engine reported before its call arrived holds the
        // call's place: the real announcement fills that row in.
        const placeholder = entries.findIndex(
          (entry) => entry.kind === "tool" && entry.toolId === msg.id && entry.synthetic,
        );
        const announced: ToolEntry = {
          kind: "tool",
          id: placeholder >= 0 ? (entries[placeholder] as ToolEntry).id : nextTranscriptId++,
          toolId: msg.id,
          name: msg.name,
          detail: msg.detail,
          input: msg.input,
          parentId: msg.parentId,
          ...(msg.actions?.length ? { actions: msg.actions } : {}),
          // The wire's stamp first (the ring knows the attempt even when the
          // task frame trails this call on replay), else the task as known here.
          ...((msg.attempt ?? (msg.parentId ? tasks.get(msg.parentId)?.attempt : undefined)) !== undefined
            ? { attempt: msg.attempt ?? tasks.get(msg.parentId!)?.attempt }
            : {}),
          batchId,
          settled: false,
          startedAt: placeholder >= 0 ? (entries[placeholder] as ToolEntry).startedAt : readNow(),
          ...(msg.replay ? { replayed: true } : {}),
        };
        if (placeholder >= 0) {
          const updated = [...entries];
          updated[placeholder] = announced;
          entries = updated;
        } else {
          entries = [...entries, announced];
        }
        return true;
      }
      case "tool_update": {
        entries = entries.map((entry) =>
          entry.kind === "tool" && entry.toolId === msg.id && entry.output === undefined
            ? {
                ...entry,
                ...(msg.detail !== undefined ? { detail: msg.detail } : {}),
                ...(msg.input !== undefined ? { input: msg.input } : {}),
                ...(msg.elapsedMs !== undefined ? { elapsedMs: msg.elapsedMs } : {}),
              }
            : entry,
        );
        return true;
      }
      case "tool_output_delta": {
        // Once a replacement snapshot exists for the row, the legacy prefix
        // is redundant — the snapshot is the whole truth of what was seen.
        entries = entries.map((entry) =>
          entry.kind === "tool" && entry.toolId === msg.id && entry.output === undefined && !entry.live
            ? { ...entry, streamed: (entry.streamed ?? "") + msg.text }
            : entry,
        );
        return true;
      }
      case "tool_output_snapshot": {
        // Newest revision wins; a replayed or reordered older snapshot can
        // never overwrite fresher state, and a settled row ignores stragglers.
        const live: LiveOutputView = {
          head: msg.head,
          ...(msg.tail !== undefined ? { tail: msg.tail } : {}),
          ...(msg.omittedBytes !== undefined ? { omittedBytes: msg.omittedBytes } : {}),
          revision: msg.revision,
        };
        if (!toolEntry(msg.id)) {
          const prior = orphans.get(msg.id);
          if (!prior?.output && msg.revision > (prior?.live?.revision ?? 0)) {
            rememberOrphan(msg.id, { live, parentId: msg.parentId }, Boolean(msg.replay));
          }
          return true;
        }
        entries = entries.map((entry) =>
          entry.kind === "tool" &&
          entry.toolId === msg.id &&
          entry.output === undefined &&
          msg.revision > (entry.live?.revision ?? 0)
            ? { ...entry, streamed: undefined, live }
            : entry,
        );
        return true;
      }
      case "tool_result": {
        const outcome = {
          output: msg.output,
          truncatedBytes: msg.truncatedBytes,
          isError: msg.isError,
          ...(msg.tail !== undefined ? { tail: msg.tail } : {}),
          ...(msg.omittedBytes !== undefined ? { omittedBytes: msg.omittedBytes } : {}),
          ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
          ...(msg.durationMs !== undefined ? { durationMs: msg.durationMs } : {}),
        };
        if (!toolEntry(msg.id)) {
          // Never silently ignore an outcome because its opening row was
          // evicted: hold it, and show it once the turn or replay closes.
          rememberOrphan(msg.id, { ...outcome, live: undefined, parentId: msg.parentId }, Boolean(msg.replay));
          return true;
        }
        entries = entries.map((entry) =>
          entry.kind === "tool" && entry.toolId === msg.id
            ? {
                ...entry,
                ...outcome,
                // The authoritative output subsumes the streamed copy —
                // release it (PR #80 review).
                streamed: undefined,
                live: undefined,
              }
            : entry,
        );
        return true;
      }
      case "task_update": {
        // The engine's word on a task, keyed by the anchor every lane groups
        // by; newest wins. A task with no announcing call of its own (a
        // background job, or a spawn evicted from replay) gets a placeholder
        // anchor so its state and report have a row to live on — the real
        // announcement, if it ever arrives, fills that row in.
        // Engines do not repeat durable fields on every frame (a completed
        // task_updated after a report-bearing notification; a Codex wait
        // without the message seen earlier): the report, its retention
        // facts, the duration, and the identity carry over; the state and
        // the transient current action are the newest frame's (PR #120
        // review).
        const prior = tasks.get(msg.id);
        // A task running AGAIN after a terminal word is a new attempt: the
        // earlier report and duration are not carried into it (release
        // review, 0.10.0).
        // Only a TERMINAL word starts a new attempt: `unknown` is the turn
        // end's guess for a task that never spoke, and its first `running`
        // afterwards is the same attempt (PR #125 review).
        const restarted =
          msg.state === "running" &&
          prior !== undefined &&
          (prior.state === "completed" || prior.state === "failed" || prior.state === "interrupted");
        // The "new attempt" mark holds until this attempt reports something
        // of its own, so the anchor call's earlier output is not shown as
        // its report meanwhile.
        // The mark also arrives on the wire (the ring's retained frame after
        // a full replay) and survives a reportless terminal frame: only this
        // attempt's own report ends it.
        // A new attempt is either seen locally (a terminal word, then
        // running) or told by the wire (the ring's mark on a tail-resumed
        // frame when this viewport last saw the old attempt still running):
        // neither carries the old attempt's report or duration (PR #125).
        const newAttempt = restarted || (msg.attempt !== undefined && msg.attempt !== prior?.attempt);
        const fresh = msg.report === undefined && (newAttempt || prior?.restarted === true);
        const attempt = msg.attempt ?? prior?.attempt;
        const lifecycle: TaskLifecycle = {
          state: msg.state,
          ...(fresh ? { restarted: true } : {}),
          ...(attempt !== undefined ? { attempt } : {}),
          ...(msg.label !== undefined ? { label: msg.label } : prior?.label !== undefined ? { label: prior.label } : {}),
          ...(msg.agentType !== undefined ? { agentType: msg.agentType } : prior?.agentType !== undefined ? { agentType: prior.agentType } : {}),
          ...(msg.action !== undefined ? { action: msg.action } : {}),
          ...(msg.report !== undefined
            ? {
                report: msg.report,
                ...(msg.reportTail !== undefined ? { reportTail: msg.reportTail } : {}),
                ...(msg.reportOmittedBytes !== undefined ? { reportOmittedBytes: msg.reportOmittedBytes } : {}),
              }
            : prior?.report !== undefined && !newAttempt
              ? {
                  report: prior.report,
                  ...(prior.reportTail !== undefined ? { reportTail: prior.reportTail } : {}),
                  ...(prior.reportOmittedBytes !== undefined ? { reportOmittedBytes: prior.reportOmittedBytes } : {}),
                }
              : {}),
          ...(msg.elapsedMs !== undefined ? { elapsedMs: msg.elapsedMs } : prior?.elapsedMs !== undefined && !newAttempt ? { elapsedMs: prior.elapsedMs } : {}),
          ...(msg.replay ? { replayed: true } : {}),
        };
        tasks = new Map(tasks).set(msg.id, lifecycle);
        // The attempt BOUNDARY is the terminal-to-running transition seen
        // here, or the wire's attempt number changing — not every later
        // frame of the same attempt, or the clock would restart on each
        // progress frame (PR #125 rounds 5–6).
        // A first-seen marked frame (a full replay) is a boundary too: with
        // every subagent call carrying its attempt, retirement below spares
        // the current attempt's calls and retires only older ones (round 10).
        const attemptBoundary = newAttempt;
        // What this boundary starts: the wire's number, else one past the last.
        const startingAttempt = msg.attempt ?? (prior?.attempt ?? 1) + 1;
        if (attemptBoundary) {
          // A new attempt's clock starts now — when the restart is live. A
          // replayed restart's real time is unknown, so the anchor reads as
          // replayed (no live clock) rather than counting from reconnection.
          // The old attempt's still-open child calls are retired: no turn
          // end will close them (the root turn may be long over), and the
          // deck must not claim the new attempt is running the old command.
          entries = entries.map((entry) => {
            if (entry.kind !== "tool") return entry;
            if (entry.toolId === msg.id) return { ...entry, startedAt: readNow(), replayed: msg.replay ? true : undefined };
            // Retired as settled, not as an error: an errored child call is
            // surfaced at the root by design (`nested`), and this one is
            // the old attempt's leftover, not something the reader must act on.
            // Only an EARLIER attempt's open call is retired: a call the ring
            // stamped with this attempt may precede the frame on a resume.
            if (entry.parentId === msg.id && entry.output === undefined && (entry.attempt ?? 1) < startingAttempt) {
              return { ...entry, settled: true, ...interruptedOutcome(entry), streamed: undefined, live: undefined };
            }
            return entry;
          });
        }
        if (!toolEntry(msg.id)) {
          // An outcome that arrived before this anchor (its opening was
          // evicted) belongs to it: the placeholder is born settled with
          // that outcome instead of the orphan being lost (PR #120 review).
          const pending = orphans.get(msg.id);
          if (pending) orphans = new Map([...orphans].filter(([id]) => id !== msg.id));
          entries = [
            ...entries,
            {
              kind: "tool",
              id: nextTranscriptId++,
              toolId: msg.id,
              name: msg.label ?? "task",
              detail: msg.label,
              parentId: msg.parentId,
              batchId: openToolBatches[0] ?? orphanToolBatch,
              settled: pending?.output !== undefined,
              startedAt: readNow(),
              synthetic: true,
              ...(msg.replay || pending?.replayed ? { replayed: true } : {}),
              ...(pending?.output !== undefined
                ? {
                    output: pending.output,
                    ...(pending.tail !== undefined ? { tail: pending.tail } : {}),
                    ...(pending.omittedBytes !== undefined ? { omittedBytes: pending.omittedBytes } : {}),
                    ...(pending.truncatedBytes !== undefined ? { truncatedBytes: pending.truncatedBytes } : {}),
                    isError: pending.isError,
                    ...(pending.exitCode !== undefined ? { exitCode: pending.exitCode } : {}),
                    ...(pending.durationMs !== undefined ? { durationMs: pending.durationMs } : {}),
                  }
                : pending?.live
                  ? { live: pending.live }
                  : {}),
            },
          ];
        }
        return true;
      }
      case "turn_end": {
        settleTurn(readNow);
        return true;
      }
      case "error": {
        // A terminal error ends the turn without a turn_end (the adapter-crash
        // path): anchorless narration is just as orphaned here, and an open
        // reasoning row is done — it must not keep pulsing "Thinking…" over
        // an idle shell (PR #120 review). A request-scoped error (terminal:
        // false) ends nothing — same reading as turn-busy and the daemon's
        // session state.
        if (msg.terminal !== false) {
          foldThinking();
          settleTurn(readNow);
        }
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
        // Output for a command whose start was evicted gets an orphan row,
        // like a tool call's — a viewport attaching mid-command (it holds
        // the controls from session_created.bang) must see what it drives.
        if (!entries.some((entry) => entry.kind === "bang" && entry.bangId === msg.id)) {
          streamingId = null;
          const known = attachBang?.id === msg.id ? attachBang : undefined;
          entries = [
            ...entries,
            {
              kind: "bang",
              id: nextTranscriptId++,
              bangId: msg.id,
              command: known?.command ?? ORPHAN_BANG_COMMAND,
              output: "",
              done: false,
              ...(known?.silent ? { silent: true as const } : {}),
            },
          ];
        }
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
        tasks = new Map();
        orphans = new Map();
        return true;
      }
      case "replay_complete": {
        // History is delivered: outcomes whose openings were evicted get
        // their explicit rows now, and evicted older history is said once,
        // at the top, in the shell's own voice.
        let touched = materializeOrphans(readNow, false);
        // A `!` the daemon reported running whose start (and any output) the
        // history no longer holds still gets its row, so its end has a place
        // to land instead of the command vanishing when its bar closes.
        // It began before everything retained, so it sits at the top with
        // the other orphaned openings, never after newer traffic.
        if (attachBang && !entries.some((entry) => entry.kind === "bang" && entry.bangId === attachBang!.id)) {
          entries = [
            { kind: "bang", id: nextTranscriptId++, bangId: attachBang.id, command: attachBang.command, output: "", done: false, ...(attachBang.silent ? { silent: true as const } : {}) },
            ...entries,
          ];
          touched = true;
        }
        if (msg.evicted && !entries.some((entry) => entry.kind === "notice" && entry.text === EVICTED_HISTORY_NOTICE)) {
          entries = [{ kind: "notice", id: nextTranscriptId++, text: EVICTED_HISTORY_NOTICE, noticeKind: "info" }, ...entries];
          touched = true;
        }
        return touched || changed;
      }

      // Shell state, connection plumbing, and per-viewport request replies do
      // not create output-zone rows. Listing every arm keeps additions to the
      // wire union reviewable at compile time; a runtime-unknown arm still
      // reaches the inert default below for version-skew compatibility.
      case "session_created":
        attachBang = msg.bang ?? null;
        return false;
      case "prompt_options":
      case "status":
      case "permission_request":
      case "permission_resolved":
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
      if (changed) snapshot = buildSnapshot(entries, tasks, snapshot);
      return { snapshot, tailIntents };
    },
  };
}
