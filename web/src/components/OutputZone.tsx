import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Action, AgentCapabilities } from "@protocol";
import type { ZoneMsg } from "../transport/session-bus";
import { loadDisclosure, saveDisclosure, withChoice } from "../transcript/disclosure-store";
import { RenderBlock, RenderBoundary } from "../registry/RenderBlock";
import { workspaceMarkdown, WorkspaceMarkdownContext } from "../registry/Md";
import { PinDock } from "./PinDock";
import { InputNavigationStop } from "./InputNavigation";
import { ToolBlock, formatBytes, formatDuration } from "./ToolBlock";
import { visibleControls } from "../visible-controls";
import { Artifact } from "./Artifact";
import { PickerBlock } from "./PickerBlock";
import { GearGlyph } from "./GearGlyph";
import { ResponseDocument } from "./ResponseDocument";
import { useFollowTail } from "../hooks/use-follow-tail";
import { loadPins, savePins } from "../transcript/pin-store";
import { sessionIdFromPath } from "../transport/session-url";
import { createTranscriptIngress } from "../transcript/delta-queue";
import { deckElapsedSeconds } from "../transcript/subagent-deck";
import { groupResponseDocuments } from "../transcript/response-document";
import { shouldFocusPromptFromTranscriptPointer } from "../transcript/transcript-focus";
import {
  useInputNavigation,
  type InputNavigationHandle,
  type InputNavigationState,
  type InputNavigationTarget,
} from "../input/use-input-navigation";
import {
  createTranscriptProjection,
  type OutputZoneRow,
  type SubagentDeckRow,
  type ThinkingRow,
  type ToolFoldRow,
  type ToolRow,
} from "../transcript/transcript-projection";

/** One explicit open/closed choice, keyed by wire identity (Phase TF R6). */
type Toggle = (key: string, expanded: boolean) => void;

/** The reader's disclosure, resolved per item: an explicit choice wins;
 *  otherwise the mode decides (details opens everything; compact opens
 *  only what its own default says). */
type Disclosure = {
  choices: ReadonlyMap<string, boolean>;
  details: boolean;
  toggle: Toggle;
  capabilities?: AgentCapabilities;
};

const isOpen = (d: Disclosure, key: string, compactDefault = false): boolean =>
  d.choices.get(key) ?? (d.details ? true : compactDefault);

/** Stable disclosure keys — wire identity, never mount position. */
const toolKey = (toolId: string) => `tool:${toolId}`;
const thinkKey = (row: ThinkingRow) => `think:${row.wireKey}`;
const foldKey = (anchorToolId: string) => `fold:${anchorToolId}`;
const deckKey = (toolId: string) => `deck:${toolId}`;

/** The transcript fields ToolBlock renders, picked off any tool-shaped
 *  record — the one spread all three ToolBlock sites share. */
const toolBlockProps = (call: {
  name: string;
  detail?: string;
  input?: Record<string, unknown>;
  output?: string;
  tail?: string;
  omittedBytes?: number;
  truncatedBytes?: number;
  isError?: boolean;
  exitCode?: number;
  durationMs?: number;
  elapsedMs?: number;
  actions?: ToolRow["actions"];
  streamed?: string;
  live?: ToolRow["live"];
  orphaned?: boolean;
}) => ({
  name: call.name,
  detail: call.detail,
  input: call.input,
  output: call.output,
  tail: call.tail,
  omittedBytes: call.omittedBytes,
  truncatedBytes: call.truncatedBytes,
  isError: call.isError,
  exitCode: call.exitCode,
  durationMs: call.durationMs,
  elapsedMs: call.elapsedMs,
  actions: call.actions,
  streamed: call.streamed,
  live: call.live,
  orphaned: call.orphaned,
});

/** One tool row under the reader's disclosure: errors open by default in
 *  compact mode; everything opens in details mode; an explicit choice wins. */
function DisclosedTool({ row, d }: { row: ToolRow; d: Disclosure }) {
  const key = toolKey(row.toolId);
  return (
    <ToolBlock
      toggleKey={key}
      expanded={isOpen(d, key, row.output !== undefined && row.isError === true)}
      onToggle={d.toggle}
      liveOutputAvailable={d.capabilities?.liveOutput}
      {...toolBlockProps(row)}
    />
  );
}

// Memoized on the entry's text: a settled block's markdown tree is reused
// as-is while later entries stream.
type AssistantMarkdown = ReturnType<typeof workspaceMarkdown>;

const AssistantTurn = memo(function AssistantTurn({
  text,
  markdown,
  narration,
}: {
  text: string;
  markdown: AssistantMarkdown;
  /** Engine-declared commentary that did not fold into an activity record
   *  (nothing followed it): shown as narration, dim, so the answer stands out. */
  narration?: boolean;
}) {
  return (
    <div className={narration ? "turn turn-assistant turn-narration markdown" : "turn turn-assistant markdown"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={markdown.urlTransform}
        components={markdown.components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// Untouched entries keep their object identity across state updates, so the
// memo comparison is the entry reference itself. Reasoning is collapsed
// from its first delta (Phase TF R1): one quiet "Thinking" control, opened
// by click or keyboard; the text never grows a paragraph in the default
// view, and it is never re-titled — no engine here supplies a reasoning
// title, so the label is the plain word.
const ThinkingBlock = memo(function ThinkingBlock({
  entry,
  expanded,
  onToggle,
}: {
  entry: ThinkingRow;
  expanded: boolean;
  onToggle: Toggle;
}) {
  const key = thinkKey(entry);
  return (
    <div
      className={
        "thinking-block" +
        (expanded ? "" : " thinking-folded") +
        (entry.done ? " thinking-done" : " thinking-streaming")
      }
    >
      <button
        className="thinking-head"
        onClick={() => onToggle(key, !expanded)}
        aria-expanded={expanded}
        title={expanded ? "Hide the reasoning" : "Show the reasoning"}
      >
        <span className="thinking-glyph" aria-hidden="true">✳</span>
        <span>{entry.done ? "Thinking" : "Thinking…"}</span>
      </button>
      {expanded && <div className="thinking-text">{entry.text}</div>}
    </div>
  );
});

/** The deck's full activity, in true stream order: tool rows plus the
 *  subagent's own narration and reasoning. Prose is INERT PLAIN TEXT —
 *  subagent words never render as markdown inside shell chrome. */
function SubagentActivity({ items, d }: { items: SubagentDeckRow["items"]; d: Disclosure }) {
  return (
    <div className="subagent-calls">
      {items.map((item) =>
        item.kind === "tool" ? (
          <DisclosedTool key={item.id} row={item} d={d} />
        ) : (
          <div
            key={item.id}
            className={
              "subagent-prose" + (item.variant === "thinking" ? " subagent-prose-thinking" : "")
            }
          >
            ✳ {item.text}
          </div>
        ),
      )}
    </div>
  );
}

const DECK_STATE_WORD: Record<SubagentDeckRow["summary"]["state"], string> = {
  running: "running",
  done: "done",
  failed: "failed",
  interrupted: "interrupted",
  unknown: "no result reported",
};

/** A spawn whose wire id other records reference as parentId — or that the
 * engine reports a task lifecycle for — becomes a live task deck: calm
 * summary (agent type, the spawn's own description, the ENGINE's state,
 * tool count, elapsed while running, current action), expandable to the
 * retained report first and the nested activity beneath. Everything shown
 * is the engine's own data rendered as inert plain text; the deck itself is
 * shell chrome, and its report can neither submit a prompt nor pose as a
 * control. Elapsed ticks only while running — a settled or replayed card
 * never shows a stale duration; an engine-measured duration is shown as
 * such. A state the engine never reported is said to be inferred. */
const SubagentDeck = memo(function SubagentDeck({
  row,
  d,
  agent,
}: {
  row: SubagentDeckRow;
  d: Disclosure;
  agent?: string;
}) {
  const { task, items, summary: s } = row;
  const key = deckKey(task.toolId);
  // An explicitly opened descendant keeps its deck open until the reader
  // closes the deck itself (R6).
  const childOpen = items.some((item) => item.kind === "tool" && d.choices.get(toolKey(item.toolId)) === true);
  const open = d.choices.get(key) ?? (d.details || childOpen);
  const running = s.state === "running";
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsed = deckElapsedSeconds(task, running, Date.now());
  const stateWord = running ? s.currentAction : DECK_STATE_WORD[s.state];
  const noChildLane = d.capabilities?.childActivity === false;
  return (
    <div
      className={`subagent-deck subagent-deck-${s.state}${s.reported ? "" : " subagent-deck-inferred"}`}
      role="group"
      aria-label={`task: ${s.description} (${DECK_STATE_WORD[s.state]}${s.reported ? "" : ", inferred"})`}
    >
      <button
        className="subagent-deck-head"
        onClick={() => d.toggle(key, !open)}
        aria-expanded={open}
        title={open ? "Hide this task's report and activity" : "Show this task's report and activity"}
      >
        <span className="subagent-dot" aria-hidden="true" />
        {s.agentType && <span className="subagent-type">{s.agentType}</span>}
        <span className="subagent-desc">{s.description}</span>
        <span
          className={"subagent-live" + (s.reported ? "" : " subagent-live-inferred")}
          title={s.reported ? undefined : "inferred from the spawn call's result — the engine reported no task state"}
        >
          {stateWord}
        </span>
        <span className="subagent-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      <div className="subagent-deck-meta">
        <GearGlyph size="1em" /> {s.toolCount} tool{s.toolCount === 1 ? "" : "s"}
        {elapsed !== undefined ? ` · ${elapsed}s` : s.elapsedMs !== undefined ? ` · ${formatDuration(s.elapsedMs)}` : ""}
        {!running && s.resultLine ? (
          <span className="subagent-result"> · {s.resultLine}</span>
        ) : null}
      </div>
      {open && (
        <>
          {s.report ? (
            <>
              <div className="subagent-report-label">{running ? "report so far" : "report"}</div>
              <pre className="subagent-report">
                {s.report.text}
                {s.report.omittedBytes ? (
                  <span className="tool-elided">
                    {"\n⋯ "}
                    {formatBytes(s.report.omittedBytes)} {s.report.tail !== undefined ? "omitted between head and tail" : "not retained"} ⋯{s.report.tail !== undefined ? "\n" : ""}
                  </span>
                ) : null}
                {s.report.tail}
              </pre>
            </>
          ) : !running ? (
            <div className="subagent-report-label">no report was retained</div>
          ) : null}
          {items.length > 0 ? (
            <SubagentActivity items={items} d={d} />
          ) : noChildLane ? (
            <div className="subagent-lane-note">
              {agent ?? "this agent"} does not report a task's own calls and prose; only its state and report are available
            </div>
          ) : running ? (
            <div className="subagent-lane-note">no child activity reported yet</div>
          ) : null}
        </>
      )}
    </div>
  );
});

/** A turn's routine engine work — the reads, listings, and searches the
 * ENGINE classified as such — as one terminal-sized line: "Read 8 files ·
 * 3 searches" with the paths and queries it named, "working" while the
 * turn runs and the group grows, "worked" once it settles, with every
 * retained call still available on demand in true transcript order (the
 * reasoning between two routine calls rides inside). Commands, edits,
 * failures, and every message stay outside as their own rows. */
function ToolActivityGroup({ row, d }: { row: ToolFoldRow; d: Disclosure }) {
  const { items } = row;
  const anchor = items.find((item) => item.kind === "tool");
  const key = foldKey(anchor && anchor.kind === "tool" ? anchor.tool.toolId : String(row.id));
  // A call the reader opened stays reachable as it moves into the group:
  // the group opens to reveal it until the reader closes the group itself.
  const childOpen = items.some(
    (item) =>
      (item.kind === "tool" && d.choices.get(toolKey(item.tool.toolId)) === true) ||
      (item.kind === "thinking" && d.choices.get(thinkKey(item.thinking)) === true),
  );
  const open = d.choices.get(key) ?? (d.details || childOpen);
  const label = `${row.live ? "working" : "worked"} · ${row.actionCount} action${row.actionCount === 1 ? "" : "s"}`;
  return (
    <div className={"tool-activity-group" + (row.live ? " tool-activity-live" : "")}>
      <button
        className="tool-activity-head"
        onClick={() => d.toggle(key, !open)}
        aria-expanded={open}
        aria-label={`${label}: ${row.summary}`}
        title={open ? "Hide the individual calls" : "Show the individual calls"}
      >
        <span className="subagent-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="tool-activity-label">
          <GearGlyph size="1em" /> {label}
        </span>
        <span className="tool-activity-summary">{row.summary}</span>
        {row.targets.length > 0 && (
          <span className="tool-activity-targets">{row.targets.map(visibleControls).join(" · ")}</span>
        )}
      </button>
      {open && (
        <div className="tool-activity-calls">
          {items.map((item) =>
            item.kind === "tool" ? (
              <DisclosedTool key={item.tool.id} row={item.tool} d={d} />
            ) : (
              <ThinkingBlock
                key={item.thinking.id}
                entry={item.thinking}
                expanded={isOpen(d, thinkKey(item.thinking))}
                onToggle={d.toggle}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

type OutputZoneProps = {
  subscribe: (l: (m: ZoneMsg) => void) => () => void;
  // Shell-provided sender for prompt/tool actions; state actions
  // are resolved here because pin state is output-zone state.
  sendAction: (action: Action, sourceId: string) => void;
  // Shell's turn-in-flight flag — only the welcome card reads it here (it
  // must not flash up mid-turn on an entry-less transcript). The activity
  // indicator itself is Shell chrome (ActivityLine), not a transcript entry,
  // so no scroll position can hide it.
  busy: boolean;
  focusPrompt: () => void;
  workspaceRoot?: string;
  onOpenWorkspaceFile?: (path: string) => void;
  onInputNavigationChange?: (state: InputNavigationState) => void;
  /** Session identity for per-session viewer state (pins); absent = don't persist. */
  sessionKey?: string;
  /** The transcript's detail mode (Phase TF R6): compact by default. */
  details?: boolean;
  /** What this session's agent can report — decides what silence means. */
  capabilities?: AgentCapabilities;
  /** The agent's display name, for honest capability notes in shell chrome. */
  agent?: string;
};

/**
 * The output zone renders projected transcript rows. Level 1: streamed text
 * renders as sanitized markdown (react-markdown never emits raw HTML).
 * Level 2: projected render rows mount registry components inline.
 */
export const OutputZone = forwardRef<InputNavigationHandle, OutputZoneProps>(function OutputZone({
  subscribe,
  sendAction,
  busy,
  focusPrompt,
  workspaceRoot,
  onOpenWorkspaceFile,
  onInputNavigationChange,
  sessionKey,
  details = false,
  capabilities,
  agent,
}, navigationRef) {
  // Pinning is pure output-zone state: wire ids (render or artifact) in pin
  // order, kept per session (pin-store.ts) so a switch away and back keeps
  // the dock. The URL names the session before any message arrives, so the
  // restore is a plain initializer. Saving waits for Shell's session key,
  // which arrives after mount — and if the daemon attached us to a DIFFERENT
  // session than the URL named (its fallback for a dead id), the restored
  // pins belong to the old one: load that session's own instead of saving
  // a stranger's under it.
  const restoredFor = useRef(sessionIdFromPath(location.pathname));
  const [pinned, setPinned] = useState<string[]>(() =>
    restoredFor.current ? loadPins(restoredFor.current) : [],
  );
  useEffect(() => {
    if (!sessionKey) return;
    if (restoredFor.current !== sessionKey) {
      // The URL's session is gone for good: its stored pins go with it, and
      // its disclosure choices must not be carried into (or saved under)
      // the fallback session's key (review 2026-09-15).
      if (restoredFor.current) savePins(restoredFor.current, []);
      restoredFor.current = sessionKey;
      setPinned(loadPins(sessionKey));
      setChoices(loadDisclosure(sessionKey), sessionKey);
      return;
    }
    savePins(sessionKey, pinned);
  }, [sessionKey, pinned]);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  // Streamed output scrolls you down only while you're already at the bottom
  // — terminal-scrollback behavior, in use-follow-tail.ts.
  const tail = useFollowTail();
  const [projection] = useState(() => createTranscriptProjection());
  const [transcript, setTranscript] = useState(
    () => projection.apply([], Date.now).snapshot,
  );
  // Disclosure belongs to the renderer, keyed by WIRE identity (Phase TF
  // R6): a finished call migrates from its own row into a group (a
  // remount), a replay rebuilds every row, a session switch is a whole
  // navigation — and the reader's explicit open/closed choices ride along
  // through all of it, restored from this tab's storage per session.
  // The choices carry the session they were loaded for: the save effect
  // writes only when they belong to the current key, so a session switch or
  // fallback can never store the old session's choices under the new key
  // in the commit before the reload lands (PR #120 review round 2).
  const [choices, setChoicesState] = useState<{ key: string | undefined; map: ReadonlyMap<string, boolean> }>(() => ({
    key: restoredFor.current || undefined,
    map: restoredFor.current ? loadDisclosure(restoredFor.current) : new Map(),
  }));
  const setChoices = useCallback((map: ReadonlyMap<string, boolean>, key: string | undefined) => setChoicesState({ key, map }), []);
  useEffect(() => {
    if (!sessionKey || choices.key !== sessionKey) return;
    saveDisclosure(sessionKey, choices.map);
  }, [sessionKey, choices]);
  const assistantMarkdown = useMemo(
    () => workspaceMarkdown(workspaceRoot, onOpenWorkspaceFile),
    [workspaceRoot, onOpenWorkspaceFile],
  );

  useEffect(() => {
    const ingress = createTranscriptIngress((messages) => {
      const result = projection.apply(messages, Date.now);
      for (const intent of result.tailIntents) {
        if (intent === "arm-follow") {
          tail.armFollow();
        } else {
          // A whole-buffer replay repaints the same wire identities: the
          // reader's disclosure choices survive it by design.
          tail.resetTail();
        }
      }
      setTranscript(result.snapshot);
    });
    const unsubscribe = subscribe(ingress.accept);
    return () => {
      unsubscribe();
      ingress.dispose();
    };
  }, [projection, subscribe]);

  // Layout effect, not passive: the catch-up scroll must land inside the
  // commit, before the browser can paint — a passive effect runs a task
  // later, so a session switch's whole-buffer replay painted top-anchored
  // for a frame and the reader saw the transcript flash-scroll to the
  // bottom (cockpit follow-up, 2026-08-31; pinned in follow-tail.e2e.ts).
  useLayoutEffect(tail.followTail, [transcript, choices, details]);

  const togglePin = useCallback(
    (renderId: string) =>
      setPinned((p) =>
        p.includes(renderId) ? p.filter((id) => id !== renderId) : [...p, renderId],
      ),
    [],
  );

  const handleAction = useCallback(
    (action: Action, sourceId: string) => {
      if (action.kind === "state") {
        setPinned((p) =>
          action.op === "pin"
            ? p.includes(action.renderId)
              ? p
              : [...p, action.renderId]
            : p.filter((id) => id !== action.renderId),
        );
        return; // state actions never leave the output zone
      }
      sendAction(action, sourceId);
    },
    [sendAction],
  );

  const toggle = useCallback<Toggle>(
    (key, expanded) =>
      setChoicesState((current) => ({ key: current.key ?? sessionKey, map: withChoice(current.map, key, expanded) })),
    [sessionKey],
  );
  const disclosure = useMemo<Disclosure>(
    () => ({ choices: choices.map, details, toggle, capabilities }),
    [choices, details, toggle, capabilities],
  );

  // Dock items reference the same painting objects the transcript holds, so an
  // update-in-place render/artifact (same wire id) keeps pinned blocks live.
  // The dock exists for THESE — a stored id whose painting is not in the
  // transcript (trimmed replay, another session's pin) renders nothing.
  const pinnedItems = useMemo(
    () => pinned.flatMap((id) => transcript.paintingsById.get(id) ?? []),
    [pinned, transcript.paintingsById],
  );
  const displayItems = useMemo(
    () => groupResponseDocuments(transcript.rows),
    [transcript.rows],
  );
  const inputNavigationFor = useInputNavigation({
    rows: transcript.rows,
    tail,
    focusPrompt,
    onChange: onInputNavigationChange,
    ref: navigationRef,
  });

  const handleTranscriptPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      shouldFocusPromptFromTranscriptPointer(
        event,
        event.currentTarget,
        window.getSelection()?.isCollapsed === false,
      )
    ) {
      focusPrompt();
    }
  };

  const handleTranscriptKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.target !== event.currentTarget ||
      event.key !== "End" ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    ) return;
    // Native End performs the scroll. Arm here as the intent, because an
    // already-bottom transcript produces no scroll event to do it for us.
    tail.armFollow();
  };

  const outputZoneEntry = (entry: OutputZoneRow) => (
    <RenderBoundary key={entry.id} fallback={<ZoneRowFallback entry={entry} />}>
      <ZoneEntry
        entry={entry}
        disclosure={disclosure}
        agent={agent}
        handleAction={handleAction}
        pinned={pinned}
        togglePin={togglePin}
        inputNavigation={inputNavigationFor(entry.id)}
        assistantMarkdown={assistantMarkdown}
      />
    </RenderBoundary>
  );

  return (
    <WorkspaceMarkdownContext.Provider value={assistantMarkdown}>
    <div className="zone-row">
      {/* The transcript column: the scroller plus the one thing that floats
          over it. The pill lives OUTSIDE the scroller's flow on purpose — a
          child of the scroller would be scrolled "into view" (to the bottom)
          by focus or by automation, which re-arms following and hides it. */}
      <div className="transcript-column">
      {/* role="log" names this as the running conversation so a screen reader
          can navigate it; aria-live is explicitly OFF because log's implicit
          "polite" would re-read the transcript on every streamed token. The
          spoken half lives in Announcer.tsx. */}
      <div
        className="output-zone"
        role="log"
        aria-live="off"
        aria-label="Conversation transcript"
        // An overflowing transcript can contain only inert prose. Keep the
        // scroller itself in the tab order so keyboard users can PageUp/End;
        // the global :focus-visible rule supplies its visible focus ring.
        tabIndex={0}
        ref={tail.scrollerRef}
        onScroll={tail.onScroll}
        onWheel={tail.onWheel}
        onTouchStart={tail.onTouchStart}
        onTouchMove={tail.onTouchMove}
        onKeyDown={handleTranscriptKeyDown}
        onPointerUp={handleTranscriptPointerUp}
      >
        {!transcript.hasTranscriptContent && !busy && (
          // A fresh session (no transcript yet) shows an inviting welcome
          // instead of raw emptiness. Shell-owned and agent-neutral.
          <div className="zone-empty">
            {/* The greeting lockup (settled 2026-07-18 after live mock
                iteration with Kyle — don't relitigate): the FULL brand mark,
                a hand-kept copy of logo.svg pinned by brand-mark.test.ts,
                HANGS off the title's left so title and subtitle share the
                true page centerline (centering icon+title as one flex box
                leaned the text right; centered-above read as a splash
                screen; untiled/watermark/45px-inline variants and the 👋
                were all tried and rejected — the bare exclamation is the
                warmth). Asset colors stay FIXED: an app-icon object carries
                its own background on any canvas — it pops on light themes,
                recedes to a subtle well on dark ones, and on Standard's
                pure black the strokes alone carry it (accepted). */}
            <div className="zone-empty-hello">
              <svg
                className="zone-empty-mark"
                viewBox="0 0 64 64"
                aria-hidden="true"
              >
                <rect width="64" height="64" rx="13" fill="#0a0d13" />
                <g
                  fill="none"
                  stroke="#40d17f"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline
                    strokeWidth="3"
                    points="18,49 13.5,49 13.5,15 18.5,15 32,31.5 45.5,15 50.5,15 50.5,49 46,49"
                  />
                  <polyline strokeWidth="2.2" points="19,35 25,39.2 19,43.4" />
                  <line strokeWidth="2.2" x1="27" y1="43.6" x2="33" y2="43.6" />
                </g>
              </svg>
              <div className="zone-empty-title">Hello!</div>
            </div>
            <div className="zone-empty-sub">
              You're in a Mirafold session. Type a prompt below to get started.
            </div>
          </div>
        )}
        {displayItems.map((item) =>
          item.kind === "entry" ? (
            outputZoneEntry(item.row)
          ) : (
            <ResponseDocument
              key={item.key}
              responseKey={item.responseKey}
              continuation={item.continuation}
            >
              {item.rows.map(outputZoneEntry)}
            </ResponseDocument>
          ),
        )}
      </div>
      {/* The way back down: shown only while the reader is up in scrollback
          — the one fact use-follow-tail already tracks — bottom-right of the
          transcript column (never over the pin dock), bottom-center on the
          phone. */}
      <button
        type="button"
        className={"jump-to-latest" + (tail.detached ? " is-visible" : "")}
        aria-label="Jump to latest"
        title="Jump to latest"
        aria-hidden={!tail.detached}
        tabIndex={tail.detached ? 0 : -1}
        onClick={() => {
          tail.jumpToTail();
          focusPrompt();
        }}
      >
        ↓
      </button>
      </div>
      {pinnedItems.length > 0 &&
        (dockCollapsed ? (
          <button
            className="pin-tab"
            onClick={() => setDockCollapsed(false)}
            title="Expand pinned"
          >
            📌 {pinnedItems.length}
          </button>
        ) : (
          <PinDock
            items={pinnedItems}
            onUnpin={togglePin}
            onCollapse={() => setDockCollapsed(true)}
            onAction={handleAction}
          />
        ))}
    </div>
    </WorkspaceMarkdownContext.Provider>
  );
});

/** One transcript entry's presentation — the per-kind branches of the
 *  scrollback. File-local on purpose: the renderers lean on OutputZone's
 *  context (pin state and the mediated action path), and brand-mark.test.ts
 *  reads this file as text. */
/** What a row degrades to when its renderer throws on engine-authored data:
 *  the raw record, legible, in place — never a blank viewport. */
function ZoneRowFallback({ entry }: { entry: OutputZoneRow }) {
  return (
    <div className="rc rc-fallback">
      <div className="rc-fallback-note">
        ⚠ couldn't draw this <code>{entry.kind}</code> row — showing its raw content
      </div>
      <pre>{JSON.stringify(entry, null, 2).slice(0, 4_000)}</pre>
    </div>
  );
}

function ZoneEntry({
  entry,
  disclosure,
  agent,
  handleAction,
  pinned,
  togglePin,
  inputNavigation,
  assistantMarkdown,
}: {
  entry: OutputZoneRow;
  disclosure: Disclosure;
  agent?: string;
  handleAction: (action: Action, sourceId: string) => void;
  pinned: string[];
  togglePin: (renderId: string) => void;
  inputNavigation?: InputNavigationTarget;
  assistantMarkdown: AssistantMarkdown;
}) {
  if (entry.kind === "thinking") {
    return (
      <ThinkingBlock
        entry={entry}
        expanded={isOpen(disclosure, thinkKey(entry))}
        onToggle={disclosure.toggle}
      />
    );
  }
  if (entry.kind === "notice") {
    const glyph =
      entry.noticeKind === "retry"
        ? "↻"
        : entry.noticeKind === "compaction"
          ? "⊙"
          : entry.noticeKind === "info"
            ? "ℹ"
            : "⚠"; // rate_limit / refusal / unknown
    // An engine's own words are BADGED and set apart: unbadged,
    // this dim line is Mirafold speaking, and text
    // chosen by a model — or by whatever a model just read — must
    // never be able to pass for that.
    return (
      <div
        className="notice-line"
        data-kind={entry.noticeKind}
        data-source={entry.source}
      >
        {entry.source ? (
          <span className="notice-source">{entry.source}</span>
        ) : (
          <span className="notice-glyph">{glyph}</span>
        )}
        <span>{entry.text}</span>
      </div>
    );
  }
  if (entry.kind === "bang") {
    return (
      <div className="bang-block">
        <InputNavigationStop
          className="turn turn-user turn-bang"
          navigation={inputNavigation}
        >
          <span
            className={entry.silent ? "glyph bang-glyph bang-glyph-silent" : "glyph bang-glyph"}
            title={entry.silent ? "Shell only — the agent never sees this command" : undefined}
          >
            {entry.silent ? "!!" : "!"}
          </span>
          <span className="turn-user-text">
            {entry.command}
            {!entry.done && <span className="bang-state">running…</span>}
            {entry.done && entry.exitCode !== 0 && (
              <span className="bang-state bang-fail">
                {entry.exitCode === null ? "killed" : `exit ${entry.exitCode}`}
              </span>
            )}
          </span>
        </InputNavigationStop>
        {entry.output && <pre className="bang-output">{entry.output}</pre>}
        {entry.done && entry.exitCode === 0 && !entry.output && (
          // Silent success must still SAY so — an empty block reads
          // as the command having vanished (terminal parity).
          <div className="bang-no-output">(completed with no output)</div>
        )}
      </div>
    );
  }
  if (entry.kind === "tool-fold") {
    return <ToolActivityGroup row={entry} d={disclosure} />;
  }
  if (entry.kind === "subagent-deck") {
    return <SubagentDeck row={entry} d={disclosure} agent={agent} />;
  }
  if (entry.kind === "tool") {
    return (
      <div className="tool-group">
        <DisclosedTool row={entry} d={disclosure} />
      </div>
    );
  }
  if (entry.kind === "picker") {
    // Shell chrome, not agent content — no pin affordance.
    return (
      <div className="turn turn-render">
        <PickerBlock
          title={entry.title}
          rows={entry.rows}
          hint={entry.hint}
          active={entry.active}
          onPick={(text) => handleAction({ kind: "prompt", text }, entry.pickerId)}
        />
      </div>
    );
  }
  if (entry.kind === "artifact") {
    if (pinned.includes(entry.artifactId)) {
      // Promoted to the dock; the stub holds its place in history.
      return (
        <button
          className="pin-stub"
          onClick={() => togglePin(entry.artifactId)}
          title="Unpin — return it here"
        >
          📌 pinned · {entry.title ?? "artifact"}
        </button>
      );
    }
    return (
      <div className="turn turn-render">
        <Artifact
          html={entry.html}
          title={entry.title}
          // Bridge actions ride the same mediated path as component
          // actions; Artifact's validation ensures no state ops.
          onAction={(action) => handleAction(action, entry.artifactId)}
          pin={{ pinned: false, onToggle: () => togglePin(entry.artifactId) }}
        />
      </div>
    );
  }
  if (entry.kind === "render") {
    if (pinned.includes(entry.renderId)) {
      // Promoted to the dock; the stub holds its place in history.
      return (
        <button
          className="pin-stub"
          onClick={() => togglePin(entry.renderId)}
          title="Unpin — return it here"
        >
          📌 pinned · {entry.component}
        </button>
      );
    }
    return (
      <div className="turn turn-render">
        {/* Shell-drawn affordance: the frame around the component,
            never inside it — the agent can't fake or grab it. */}
        <button
          className="pin-btn"
          onClick={() => togglePin(entry.renderId)}
          title="Pin — keep visible while the transcript scrolls"
        >
          📌
        </button>
        <RenderBlock
          component={entry.component}
          props={entry.props}
          renderId={entry.renderId}
          onAction={handleAction}
        />
      </div>
    );
  }
  return entry.role === "user" ? (
    <InputNavigationStop className="turn turn-user" navigation={inputNavigation}>
      <span className="glyph" aria-hidden="true">❯</span>
      <span className="turn-user-text">{entry.text}</span>
    </InputNavigationStop>
  ) : (
    <AssistantTurn text={entry.text} markdown={assistantMarkdown} narration={entry.phase === "commentary"} />
  );
}
