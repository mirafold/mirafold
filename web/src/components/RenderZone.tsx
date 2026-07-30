import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Action } from "@protocol";
import type { ZoneMsg } from "../session-bus";
import { RenderBlock } from "../registry/RenderBlock";
import { mdOverrides, mdUrlTransform } from "../registry/Md";
import { PinDock } from "./PinDock";
import { ToolBlock } from "./ToolBlock";
import { Artifact } from "./Artifact";
import { PickerBlock, type PickerRow } from "./PickerBlock";
import { GearGlyph } from "./GearGlyph";
import { useFollowTail } from "../use-follow-tail";
import { queueDelta, type QueuedDelta } from "../delta-queue";

// The scrollback is a flat list of entries: text blocks and rendered
// components, in the exact order they arrived on the wire.
type Entry =
  | { kind: "text"; id: number; role: "user" | "assistant"; text: string; done: boolean }
  | {
      kind: "render";
      id: number;
      renderId: string; // wire id — re-sends with this id update props in place
      component: string;
      props: Record<string, unknown>;
    }
  | {
      kind: "tool";
      id: number;
      toolId: string; // wire id — the matching tool_result completes this record
      name: string;
      detail?: string;
      input?: Record<string, unknown>; // full args (T2.2), rendered in the expansion
      output?: string; // undefined until the result arrives
      truncatedBytes?: number; // T2.3: bytes elided past the cap, if any
      parentId?: string; // T2.4: Task wire id if this is a subagent's call
      isError?: boolean;
    }
  | {
      kind: "artifact";
      id: number;
      artifactId: string; // wire id — re-sends with this id replace the html
      html: string;
      title?: string;
    }
  | {
      kind: "thinking";
      id: number;
      text: string;
      done: boolean; // done ⇒ folded to one line unless the user expands it
      expanded: boolean;
    }
  | {
      // A service-status line (retry, compaction, rate limit, refusal) —
      // the UI must not lie in degraded service. Persistent, dim, non-agent (F.2).
      kind: "notice";
      id: number;
      text: string;
      noticeKind?: string;
      // The engine whose own words these are; absent = Mirafold's own voice.
      source?: string;
    }
  | {
      kind: "bang"; // a `!` shell command (4.9): its strip + live PTY output
      id: number;
      bangId: string; // wire id — output/end messages complete this record
      command: string;
      output: string;
      exitCode?: number | null; // undefined while running; null = killed
      done: boolean;
    }
  | {
      // Shell-owned selector re-skinning terminal chrome (/model, /effort).
      kind: "picker";
      id: number;
      pickerId: string; // wire id — the action's sourceId when a row is picked
      title: string;
      rows: PickerRow[];
      hint?: string;
    };
type ToolCall = Extract<Entry, { kind: "tool" }>;

let nextId = 0;

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
  onToggle,
}: {
  entry: Extract<Entry, { kind: "thinking" }>;
  onToggle: (id: number) => void;
}) {
  const folded = entry.done && !entry.expanded;
  return (
    <div
      className={
        "thinking-block" +
        (folded ? " thinking-folded" : "") +
        (entry.done ? " thinking-done" : "")
      }
      onClick={entry.done ? () => onToggle(entry.id) : undefined}
      title={entry.done ? (folded ? "Expand thinking" : "Collapse thinking") : undefined}
    >
      {folded ? <>✳ {entry.text.replace(/\s+/g, " ").slice(0, 100)}…</> : entry.text}
    </div>
  );
});

/** A Task's subagent tool calls (T2.4): collapsed by default — a subagent's
 *  churn shouldn't crowd the transcript — expandable to the nested rows. */
function SubagentGroup({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  const pending = calls.some((c) => c.output === undefined);
  return (
    <div className="subagent-group">
      <button className="subagent-head" onClick={() => setOpen(!open)}>
        <span className="subagent-caret">{open ? "▾" : "▸"}</span>
        <span className="subagent-label">
          <GearGlyph size="1em" /> subagent · {calls.length} call{calls.length === 1 ? "" : "s"}
          {pending ? " …" : ""}
        </span>
      </button>
      {open && (
        <div className="subagent-calls">
          {calls.map((c) => (
            <ToolBlock
              key={c.id}
              name={c.name}
              detail={c.detail}
              input={c.input}
              output={c.output}
              truncatedBytes={c.truncatedBytes}
              isError={c.isError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The output zone — an interpreter for the wire protocol. Level 1: streamed
 * text renders as sanitized markdown (react-markdown never emits raw HTML).
 * Level 2: `render` messages mount registry components inline.
 */
export function RenderZone({
  subscribe,
  sendAction,
  busy,
}: {
  subscribe: (l: (m: ZoneMsg) => void) => () => void;
  // Shell-provided sender for prompt/tool actions (Phase 2); state actions
  // are resolved here because pin state is output-zone state.
  sendAction: (action: Action, sourceId: string) => void;
  // Shell's turn-in-flight flag — only the welcome card reads it here (it
  // must not flash up mid-turn on an entry-less transcript). The activity
  // indicator itself is Shell chrome (ActivityLine), not a transcript entry,
  // so no scroll position can hide it (2026-07-29, Kyle).
  busy: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  // Pinning is pure output-zone state: wire ids (render or artifact) in pin
  // order. The dock only exists while something is pinned (PLAN Step 1.6).
  const [pinned, setPinned] = useState<string[]>([]);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  // Streamed output scrolls you down only while you're already at the bottom
  // (2026-07-20, Kyle) — terminal-scrollback behavior, in use-follow-tail.ts.
  const tail = useFollowTail();
  // The text block currently receiving deltas. Kept in a ref so a user prompt
  // sent mid-stream can't detach the tail of the reply.
  const streamingId = useRef<number | null>(null);
  // The thinking block currently receiving deltas (T2.1).
  const thinkingId = useRef<number | null>(null);

  useEffect(
    () => {
      const apply = (msg: ZoneMsg) => {
        // Collapse-on-finalize (T2.1): the open thinking block folds the
        // moment the turn's real output starts.
        const foldThinking = () => {
          const id = thinkingId.current;
          if (id === null) return;
          thinkingId.current = null;
          setEntries((es) =>
            es.map((e) => (e.kind === "thinking" && e.id === id ? { ...e, done: true } : e)),
          );
        };
        if (
          msg.type === "text_delta" ||
          msg.type === "render" ||
          msg.type === "picker" ||
          msg.type === "tool_use" ||
          msg.type === "artifact" ||
          msg.type === "turn_end"
        ) {
          foldThinking();
        }
        switch (msg.type) {
          case "user_prompt": {
            // Sending re-arms follow: typing a message says you're back in
            // the conversation, so jump to the tail even if you'd scrolled up.
            tail.armFollow();
            const id = nextId++;
            setEntries((es) => [
              ...es,
              { kind: "text", id, role: "user", text: msg.text, done: true },
            ]);
            break;
          }
          case "thinking_delta": {
            const id = thinkingId.current;
            if (id !== null) {
              setEntries((es) =>
                es.map((e) =>
                  e.kind === "thinking" && e.id === id ? { ...e, text: e.text + msg.text } : e,
                ),
              );
            } else {
              const newId = nextId++;
              thinkingId.current = newId;
              setEntries((es) => [
                ...es,
                { kind: "thinking", id: newId, text: msg.text, done: false, expanded: false },
              ]);
            }
            break;
          }
          case "text_delta": {
            const id = streamingId.current;
            if (id !== null) {
              setEntries((es) =>
                es.map((e) =>
                  e.kind === "text" && e.id === id ? { ...e, text: e.text + msg.text } : e,
                ),
              );
            } else {
              const newId = nextId++;
              streamingId.current = newId;
              setEntries((es) => [
                ...es,
                { kind: "text", id: newId, role: "assistant", text: msg.text, done: false },
              ]);
            }
            break;
          }
          case "render": {
            // Close the streaming text block so any further deltas open a new
            // one *after* this component — the transcript keeps wire order.
            streamingId.current = null;
            const id = nextId++;
            setEntries((es) => {
              const i = es.findIndex((e) => e.kind === "render" && e.renderId === msg.id);
              if (i >= 0) {
                // Update-in-place: same wire id replaces that component's props.
                const updated = [...es];
                updated[i] = { ...(updated[i] as Entry & { kind: "render" }), component: msg.component, props: msg.props };
                return updated;
              }
              return [
                ...es,
                { kind: "render", id, renderId: msg.id, component: msg.component, props: msg.props },
              ];
            });
            break;
          }
          case "picker": {
            // Same wire-order rule as `render`: close the streaming block.
            streamingId.current = null;
            const id = nextId++;
            setEntries((es) => [
              ...es,
              { kind: "picker", id, pickerId: msg.id, title: msg.title, rows: msg.rows, hint: msg.hint },
            ]);
            break;
          }
          case "artifact": {
            // Same wire-order rule as `render`: close the streaming block.
            streamingId.current = null;
            const id = nextId++;
            setEntries((es) => {
              const i = es.findIndex(
                (e) => e.kind === "artifact" && e.artifactId === msg.id,
              );
              if (i >= 0) {
                const updated = [...es];
                updated[i] = {
                  ...(updated[i] as Entry & { kind: "artifact" }),
                  html: msg.html,
                  title: msg.title,
                };
                return updated;
              }
              return [
                ...es,
                { kind: "artifact", id, artifactId: msg.id, html: msg.html, title: msg.title },
              ];
            });
            break;
          }
          case "tool_use": {
            // Close the streaming text block (same reason as `render`):
            // later deltas must open a new block after this record.
            streamingId.current = null;
            const id = nextId++;
            setEntries((es) => [
              ...es,
              { kind: "tool", id, toolId: msg.id, name: msg.name, detail: msg.detail, input: msg.input, parentId: msg.parentId },
            ]);
            break;
          }
          case "tool_result": {
            setEntries((es) =>
              es.map((e) =>
                e.kind === "tool" && e.toolId === msg.id
                  ? { ...e, output: msg.output, truncatedBytes: msg.truncatedBytes, isError: msg.isError }
                  : e,
              ),
            );
            break;
          }
          // `status` frames are Shell's to interpret (the ActivityLine label);
          // the transcript renders nothing for them.
          case "turn_end": {
            const id = streamingId.current;
            streamingId.current = null;
            setEntries((es) =>
              es.map((e) => {
                if (e.kind === "text" && e.id === id) return { ...e, done: true };
                // A tool still pending at turn end was interrupted — settle
                // its record so the row doesn't pulse forever.
                if (e.kind === "tool" && e.output === undefined)
                  return { ...e, output: "(interrupted — no result)" };
                return e;
              }),
            );
            break;
          }
          case "error": {
            // Close the streaming text block like every other appended entry —
            // a delta after the error must open a NEW block below it, keeping
            // wire order (2026-07-28 fix: it glued onto the block ABOVE the
            // error). notice/user_prompt omit this deliberately and say so.
            streamingId.current = null;
            const id = nextId++;
            setEntries((es) => [
              ...es,
              {
                kind: "text",
                id,
                role: "assistant",
                text: `**Error:** ${msg.message}`,
                done: true,
              },
            ]);
            break;
          }
          case "notice": {
            // A dim system line in transcript order. It does NOT fold thinking
            // or close the streaming text block — a retry/compaction is a status
            // aside, not the turn's real output starting.
            const id = nextId++;
            setEntries((es) => [
              ...es,
              { kind: "notice", id, text: msg.text, noticeKind: msg.kind, source: msg.source },
            ]);
            break;
          }
          case "bang_start": {
            // Same wire-order rule as `render`: close the streaming block.
            streamingId.current = null;
            const id = nextId++;
            setEntries((es) => [
              ...es,
              { kind: "bang", id, bangId: msg.id, command: msg.command, output: "", done: false },
            ]);
            break;
          }
          case "bang_output": {
            setEntries((es) =>
              es.map((e) =>
                e.kind === "bang" && e.bangId === msg.id
                  ? { ...e, output: e.output + msg.data }
                  : e,
              ),
            );
            break;
          }
          case "bang_end": {
            setEntries((es) =>
              es.map((e) =>
                e.kind === "bang" && e.bangId === msg.id
                  ? { ...e, exitCode: msg.exitCode, done: true }
                  : e,
              ),
            );
            break;
          }
          case "zone_reset": {
            // A (re)attach replays the session's history from scratch.
            streamingId.current = null;
            thinkingId.current = null;
            tail.resetTail(); // a replayed transcript lands at its end
            setEntries([]);
            // pinned renderIds survive — the replayed render entries carry
            // the same wire ids, so pins re-bind to the repainted blocks.
            break;
          }
        }
      };
      // Streamed deltas batch into one state pass per animation frame (the
      // timer stands in where frames pause — a hidden tab). Anything else
      // applies the pending batch first, so entries keep exact wire order —
      // and every non-transcript bus listener still hears the raw stream.
      const queue: QueuedDelta[] = [];
      let frame: number | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        if (timer !== null) clearTimeout(timer);
        frame = null;
        timer = null;
        for (const m of queue.splice(0)) apply(m);
      };
      const unsubscribe = subscribe((msg) => {
        if (msg.type === "text_delta" || msg.type === "thinking_delta") {
          queueDelta(queue, msg);
          if (frame === null) {
            frame = requestAnimationFrame(flush);
            timer = setTimeout(flush, 50);
          }
          return;
        }
        flush();
        apply(msg);
      });
      return () => {
        unsubscribe();
        if (frame !== null) cancelAnimationFrame(frame);
        if (timer !== null) clearTimeout(timer);
      };
    },
    [subscribe],
  );

  useEffect(tail.followTail, [entries]);

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
      setEntries((es) =>
        es.map((e) =>
          e.kind === "thinking" && e.id === id ? { ...e, expanded: !e.expanded } : e,
        ),
      ),
    [],
  );

  // Dock items reference the same entry objects the transcript holds, so an
  // update-in-place render/artifact (same wire id) keeps pinned blocks live.
  const pinnedItems = useMemo(
    () =>
      pinned.flatMap((id) => {
        const entry = entries.find(
          (e) =>
            (e.kind === "render" && e.renderId === id) ||
            (e.kind === "artifact" && e.artifactId === id),
        );
        return entry && (entry.kind === "render" || entry.kind === "artifact") ? [entry] : [];
      }),
    [entries, pinned],
  );

  // The ACTIVE picker — the one whose arrow-key capture is live: the newest
  // copy, and only until the user moves on (a later user turn retires it).
  const activePickerId = useMemo(() => {
    let active: number | null = null;
    for (const e of entries) {
      if (e.kind === "picker") active = e.id;
      else if (e.kind === "text" && e.role === "user") active = null;
    }
    return active;
  }, [entries]);

  // Subagent calls (parentId set) grouped under their Task's wire id (T2.4).
  const childrenByParent = useMemo(() => {
    const byParent = new Map<string, ToolCall[]>();
    for (const e of entries) {
      if (e.kind === "tool" && e.parentId) {
        const arr = byParent.get(e.parentId) ?? [];
        arr.push(e);
        byParent.set(e.parentId, arr);
      }
    }
    return byParent;
  }, [entries]);

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
        ref={tail.scrollerRef}
        onScroll={tail.onScroll}
        onWheel={tail.onWheel}
        onTouchStart={tail.onTouchStart}
        onTouchMove={tail.onTouchMove}
      >
        {entries.length === 0 && !busy && (
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
        {entries.map((entry) => (
          <ZoneEntry
            key={entry.id}
            entry={entry}
            toggleThinking={toggleThinking}
            childrenByParent={childrenByParent}
            activePickerId={activePickerId}
            handleAction={handleAction}
            pinned={pinned}
            togglePin={togglePin}
          />
        ))}
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
}

/** One transcript entry's presentation — the per-kind branches of the
 *  scrollback. File-local on purpose: the renderers lean on RenderZone's
 *  context (pin state, subagent grouping, the mediated action path), and
 *  brand-mark.test.ts reads this file as text. */
function ZoneEntry({
  entry,
  toggleThinking,
  childrenByParent,
  activePickerId,
  handleAction,
  pinned,
  togglePin,
}: {
  entry: Entry;
  toggleThinking: (id: number) => void;
  childrenByParent: Map<string, ToolCall[]>;
  activePickerId: number | null;
  handleAction: (action: Action, sourceId: string) => void;
  pinned: string[];
  togglePin: (renderId: string) => void;
}) {
  if (entry.kind === "thinking") {
    return <ThinkingBlock entry={entry} onToggle={toggleThinking} />;
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
        <div className="turn turn-user turn-bang">
          <span className="glyph bang-glyph">!</span> {entry.command}
          {!entry.done && <span className="bang-state">running…</span>}
          {entry.done && entry.exitCode !== 0 && (
            <span className="bang-state bang-fail">
              {entry.exitCode === null ? "killed" : `exit ${entry.exitCode}`}
            </span>
          )}
        </div>
        {entry.output && <pre className="bang-output">{entry.output}</pre>}
        {entry.done && entry.exitCode === 0 && !entry.output && (
          // Silent success must still SAY so — an empty block reads
          // as the command having vanished (terminal parity).
          <div className="bang-no-output">(completed with no output)</div>
        )}
      </div>
    );
  }
  if (entry.kind === "tool") {
    // Subagent calls are rendered nested under their Task (below),
    // not at the top level.
    if (entry.parentId) return null;
    const children = childrenByParent.get(entry.toolId);
    return (
      <div className="tool-group">
        <ToolBlock
          name={entry.name}
          detail={entry.detail}
          input={entry.input}
          output={entry.output}
          truncatedBytes={entry.truncatedBytes}
          isError={entry.isError}
        />
        {children && children.length > 0 && <SubagentGroup calls={children} />}
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
          active={entry.id === activePickerId}
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
    <div className="turn turn-user">
      <span className="glyph">❯</span> {entry.text}
    </div>
  ) : (
    <AssistantTurn text={entry.text} />
  );
}
