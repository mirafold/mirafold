import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Action } from "@protocol";
import type { ZoneMsg } from "../session-bus";
import { RenderBlock } from "../registry/RenderBlock";
import { mdOverrides, mdUrlTransform } from "../registry/Md";
import { PinDock } from "./PinDock";
import { InputNavigationStop } from "./InputNavigation";
import { ToolBlock } from "./ToolBlock";
import { Artifact } from "./Artifact";
import { PickerBlock } from "./PickerBlock";
import { GearGlyph } from "./GearGlyph";
import { ResponseDocument } from "./ResponseDocument";
import { useFollowTail } from "../use-follow-tail";
import { createTranscriptIngress } from "../delta-queue";
import { deckElapsedSeconds } from "../subagent-deck";
import { groupResponseDocuments } from "../response-document";
import { shouldFocusPromptFromTranscriptPointer } from "../transcript-focus";
import {
  useInputNavigation,
  type InputNavigationHandle,
  type InputNavigationState,
  type InputNavigationTarget,
} from "../use-input-navigation";
import {
  createTranscriptProjection,
  type OutputZoneRow,
  type SubagentDeckRow,
  type ThinkingRow,
  type ToolFoldRow,
} from "../transcript-projection";

/** The transcript fields ToolBlock renders, picked off any tool-shaped
 *  record — the one spread all three ToolBlock sites share. */
const toolBlockProps = (call: {
  name: string;
  detail?: string;
  input?: Record<string, unknown>;
  output?: string;
  truncatedBytes?: number;
  isError?: boolean;
}) => ({
  name: call.name,
  detail: call.detail,
  input: call.input,
  output: call.output,
  truncatedBytes: call.truncatedBytes,
  isError: call.isError,
});

// Memoized on the entry's text: a settled block's markdown tree is reused
// as-is while later entries stream.
const AssistantTurn = memo(function AssistantTurn({ text }: { text: string }) {
  return (
    <div className="turn turn-assistant markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={mdUrlTransform}
        components={mdOverrides}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// Untouched entries keep their object identity across state updates, so the
// memo comparison is the entry reference itself.
const ThinkingBlock = memo(function ThinkingBlock({
  entry,
  expanded,
  onToggle,
}: {
  entry: ThinkingRow;
  expanded: boolean;
  onToggle: (id: number) => void;
}) {
  const folded = entry.done && !expanded;
  return (
    <div
      className={
        "thinking-block" +
        (folded ? " thinking-folded" : "") +
        (entry.done ? " thinking-done" : "")
      }
      data-transcript-control={entry.done ? "" : undefined}
      onClick={entry.done ? () => onToggle(entry.id) : undefined}
      title={entry.done ? (folded ? "Expand thinking" : "Collapse thinking") : undefined}
    >
      {folded ? <>✳ {entry.text.replace(/\s+/g, " ").slice(0, 100)}…</> : entry.text}
    </div>
  );
});

/** The deck's full activity, in true stream order (SA.2): tool rows plus the
 *  subagent's own narration and reasoning. Prose is INERT PLAIN TEXT —
 *  subagent words never render as markdown inside shell chrome. */
function SubagentActivity({ items }: { items: SubagentDeckRow["items"] }) {
  return (
    <div className="subagent-calls">
      {items.map((item) =>
        item.kind === "tool" ? (
          <ToolBlock key={item.id} {...toolBlockProps(item)} />
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

/** SA.1: a spawn whose wire id other records reference as parentId becomes a
 * live subagent deck — calm summary (agent type, the spawn's own description,
 * state, tool count, elapsed while running, current action), expandable to
 * the nested calls. Everything shown is the engine's own data rendered as
 * inert plain text; the deck itself is shell chrome. Elapsed ticks only
 * while running — a settled or replayed card never shows a stale duration. */
const SubagentDeck = memo(function SubagentDeck({
  row,
}: {
  row: SubagentDeckRow;
}) {
  const { task, items, summary: s } = row;
  const [open, setOpen] = useState(false);
  const running = s.state === "running";
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsed = deckElapsedSeconds(task, running, Date.now());
  return (
    <div
      className={
        "subagent-deck" +
        (running
          ? " subagent-deck-running"
          : s.state === "failed"
            ? " subagent-deck-failed"
            : " subagent-deck-done")
      }
      role="group"
      aria-label={`subagent: ${s.description} (${s.state})`}
    >
      <button
        className="subagent-deck-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? "Collapse subagent activity" : "Expand subagent activity"}
      >
        <span className="subagent-dot" aria-hidden="true" />
        {s.agentType && <span className="subagent-type">{s.agentType}</span>}
        <span className="subagent-desc">{s.description}</span>
        <span className="subagent-live">
          {running ? s.currentAction : s.state === "failed" ? "failed" : "done"}
        </span>
        <span className="subagent-caret">{open ? "▾" : "▸"}</span>
      </button>
      <div className="subagent-deck-meta">
        <GearGlyph size="1em" /> {s.toolCount} tool{s.toolCount === 1 ? "" : "s"}
        {elapsed !== undefined ? ` · ${elapsed}s` : ""}
        {!running && s.resultLine ? (
          <span className="subagent-result"> · {s.resultLine}</span>
        ) : null}
      </div>
      {open && <SubagentActivity items={items} />}
    </div>
  );
});

/** A completed turn's successful engine activity: one terminal-sized line by
 * default, with every normalized call still available on demand. The fold can
 * carry the engine's interleaved narration (Codex thinks before nearly every
 * command); expansion replays calls and thinking in true transcript order.
 * The count and summary speak of ACTIONS only — narration isn't one. */
function ToolActivityGroup({
  row,
  expandedThinking,
  onToggleThinking,
}: {
  row: ToolFoldRow;
  expandedThinking: ReadonlySet<number>;
  onToggleThinking: (id: number) => void;
}) {
  const { items } = row;
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-activity-group">
      <button
        className="tool-activity-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="subagent-caret">{open ? "▾" : "▸"}</span>
        <span className="tool-activity-label">
          <GearGlyph size="1em" /> worked · {row.actionCount} action{row.actionCount === 1 ? "" : "s"}
        </span>
        <span className="tool-activity-summary">{row.summary}</span>
      </button>
      {open && (
        <div className="tool-activity-calls">
          {items.map((item) =>
            item.kind === "tool" ? (
              <ToolBlock key={item.tool.id} {...toolBlockProps(item.tool)} />
            ) : (
              <ThinkingBlock
                key={item.thinking.id}
                entry={item.thinking}
                expanded={expandedThinking.has(item.thinking.id)}
                onToggle={onToggleThinking}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

type RenderZoneProps = {
  subscribe: (l: (m: ZoneMsg) => void) => () => void;
  // Shell-provided sender for prompt/tool actions (Phase 2); state actions
  // are resolved here because pin state is output-zone state.
  sendAction: (action: Action, sourceId: string) => void;
  // Shell's turn-in-flight flag — only the welcome card reads it here (it
  // must not flash up mid-turn on an entry-less transcript). The activity
  // indicator itself is Shell chrome (ActivityLine), not a transcript entry,
  // so no scroll position can hide it (2026-07-29, Kyle).
  busy: boolean;
  focusPrompt: () => void;
  onInputNavigationChange?: (state: InputNavigationState) => void;
};

/**
 * The output zone renders projected transcript rows. Level 1: streamed text
 * renders as sanitized markdown (react-markdown never emits raw HTML).
 * Level 2: projected render rows mount registry components inline.
 */
export const RenderZone = forwardRef<InputNavigationHandle, RenderZoneProps>(function RenderZone({
  subscribe,
  sendAction,
  busy,
  focusPrompt,
  onInputNavigationChange,
}, navigationRef) {
  // Pinning is pure output-zone state: wire ids (render or artifact) in pin
  // order. The dock only exists while something is pinned (PLAN Step 1.6).
  const [pinned, setPinned] = useState<string[]>([]);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  // Streamed output scrolls you down only while you're already at the bottom
  // (2026-07-20, Kyle) — terminal-scrollback behavior, in use-follow-tail.ts.
  const tail = useFollowTail();
  const [projection] = useState(() => createTranscriptProjection());
  const [transcript, setTranscript] = useState(
    () => projection.apply([], Date.now).snapshot,
  );
  // Disclosure belongs to the renderer, but the ids survive a thinking row
  // moving into a completed tool fold just as the old entry field did.
  const [expandedThinking, setExpandedThinking] = useState<ReadonlySet<number>>(
    () => new Set(),
  );

  useEffect(() => {
    const ingress = createTranscriptIngress((messages) => {
      const result = projection.apply(messages, Date.now);
      for (const intent of result.tailIntents) {
        if (intent === "arm-follow") {
          tail.armFollow();
        } else {
          tail.resetTail();
          setExpandedThinking(new Set());
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

  useEffect(tail.followTail, [transcript, expandedThinking]);

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

  const toggleThinking = useCallback(
    (id: number) =>
      setExpandedThinking((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  // Dock items reference the same painting objects the transcript holds, so an
  // update-in-place render/artifact (same wire id) keeps pinned blocks live.
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

  const renderZoneEntry = (entry: OutputZoneRow) => (
    <ZoneEntry
      key={entry.id}
      entry={entry}
      toggleThinking={toggleThinking}
      expandedThinking={expandedThinking}
      handleAction={handleAction}
      pinned={pinned}
      togglePin={togglePin}
      inputNavigation={inputNavigationFor(entry.id)}
    />
  );

  return (
    <div className="zone-row">
      {/* role="log" names this as the running conversation so a screen reader
          can navigate it; aria-live is explicitly OFF because log's implicit
          "polite" would re-read the transcript on every streamed token. The
          spoken half lives in Announcer.tsx (A.1). */}
      <div
        className="render-zone"
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
          // instead of raw emptiness. Shell-owned and agent-neutral (#12).
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
            renderZoneEntry(item.row)
          ) : (
            <ResponseDocument
              key={item.key}
              responseKey={item.responseKey}
              continuation={item.continuation}
            >
              {item.rows.map(renderZoneEntry)}
            </ResponseDocument>
          ),
        )}
      </div>
      {pinned.length > 0 &&
        (dockCollapsed ? (
          <button
            className="pin-tab"
            onClick={() => setDockCollapsed(false)}
            title="Expand pinned"
          >
            📌 {pinned.length}
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
  );
});

/** One transcript entry's presentation — the per-kind branches of the
 *  scrollback. File-local on purpose: the renderers lean on RenderZone's
 *  context (pin state and the mediated action path), and brand-mark.test.ts
 *  reads this file as text. */
function ZoneEntry({
  entry,
  toggleThinking,
  expandedThinking,
  handleAction,
  pinned,
  togglePin,
  inputNavigation,
}: {
  entry: OutputZoneRow;
  toggleThinking: (id: number) => void;
  expandedThinking: ReadonlySet<number>;
  handleAction: (action: Action, sourceId: string) => void;
  pinned: string[];
  togglePin: (renderId: string) => void;
  inputNavigation?: InputNavigationTarget;
}) {
  if (entry.kind === "thinking") {
    return (
      <ThinkingBlock
        entry={entry}
        expanded={expandedThinking.has(entry.id)}
        onToggle={toggleThinking}
      />
    );
  }
  if (entry.kind === "notice") {
    const glyph =
      entry.noticeKind === "retry"
        ? "↻"
        : entry.noticeKind === "compaction"
          ? "⊙"
          : "⚠"; // rate_limit / refusal / unknown
    // An engine's own words are BADGED and set apart (2026-07-20
    // audit): unbadged, this dim line is Mirafold speaking, and text
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
          <span className="glyph bang-glyph">!</span>
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
    return (
      <ToolActivityGroup
        row={entry}
        expandedThinking={expandedThinking}
        onToggleThinking={toggleThinking}
      />
    );
  }
  if (entry.kind === "subagent-deck") {
    return <SubagentDeck row={entry} />;
  }
  if (entry.kind === "tool") {
    return (
      <div className="tool-group">
        <ToolBlock {...toolBlockProps(entry)} />
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
    <AssistantTurn text={entry.text} />
  );
}
