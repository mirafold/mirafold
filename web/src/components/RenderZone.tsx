import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Action } from "@protocol";
import type { ZoneMsg } from "./Shell";
import { RenderBlock } from "../registry/RenderBlock";
import { safeAnchor } from "../registry/Md";
import { PinDock } from "./PinDock";
import { ToolBlock } from "./ToolBlock";
import { Artifact } from "./Artifact";
import { useFollowTail } from "../use-follow-tail";

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
    }
  | {
      kind: "bang"; // a `!` shell command (4.9): its strip + live PTY output
      id: number;
      bangId: string; // wire id — output/end messages complete this record
      command: string;
      output: string;
      exitCode?: number | null; // undefined while running; null = killed
      done: boolean;
    };
type Status = { state: "thinking" | "tool"; label?: string } | null;
type ToolCall = Extract<Entry, { kind: "tool" }>;

let nextId = 0;

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
          ⚙ subagent · {calls.length} call{calls.length === 1 ? "" : "s"}
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
}: {
  subscribe: (l: (m: ZoneMsg) => void) => () => void;
  // Shell-provided sender for prompt/tool actions (Phase 2); state actions
  // are resolved here because pin state is output-zone state.
  sendAction: (action: Action, sourceId: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<Status>(null);
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
    () =>
      subscribe((msg) => {
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
            setStatus({ state: "thinking" });
            break;
          }
          case "thinking_delta": {
            setStatus(null); // the streaming thought itself is the signal
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
            setStatus(null);
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
          case "status":
            setStatus({ state: msg.state, label: msg.label });
            break;
          case "turn_end": {
            setStatus(null);
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
            setStatus(null);
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
              { kind: "notice", id, text: msg.text, noticeKind: msg.kind },
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
            setStatus(null);
            setEntries([]);
            // pinned renderIds survive — the replayed render entries carry
            // the same wire ids, so pins re-bind to the repainted blocks.
            break;
          }
        }
      }),
    [subscribe],
  );

  useEffect(tail.followTail, [entries, status]);

  const togglePin = (renderId: string) =>
    setPinned((p) =>
      p.includes(renderId) ? p.filter((id) => id !== renderId) : [...p, renderId],
    );

  const handleAction = (action: Action, sourceId: string) => {
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
  };

  // Dock items reference the same entry objects the transcript holds, so an
  // update-in-place render/artifact (same wire id) keeps pinned blocks live.
  const pinnedItems = pinned.flatMap((id) => {
    const entry = entries.find(
      (e) =>
        (e.kind === "render" && e.renderId === id) ||
        (e.kind === "artifact" && e.artifactId === id),
    );
    return entry && (entry.kind === "render" || entry.kind === "artifact") ? [entry] : [];
  });

  // Subagent calls (parentId set) grouped under their Task's wire id (T2.4).
  const childrenByParent = new Map<string, ToolCall[]>();
  for (const e of entries) {
    if (e.kind === "tool" && e.parentId) {
      const arr = childrenByParent.get(e.parentId) ?? [];
      arr.push(e);
      childrenByParent.set(e.parentId, arr);
    }
  }

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
      >
        {entries.length === 0 && !status && (
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
        {entries.map((entry) => {
          if (entry.kind === "thinking") {
            const folded = entry.done && !entry.expanded;
            const toggle = entry.done
              ? () =>
                  setEntries((es) =>
                    es.map((e) =>
                      e.kind === "thinking" && e.id === entry.id
                        ? { ...e, expanded: !e.expanded }
                        : e,
                    ),
                  )
              : undefined;
            return (
              <div
                key={entry.id}
                className={
                  "thinking-block" +
                  (folded ? " thinking-folded" : "") +
                  (entry.done ? " thinking-done" : "")
                }
                onClick={toggle}
                title={entry.done ? (folded ? "Expand thinking" : "Collapse thinking") : undefined}
              >
                {folded ? (
                  <>✳ {entry.text.replace(/\s+/g, " ").slice(0, 100)}…</>
                ) : (
                  entry.text
                )}
              </div>
            );
          }
          if (entry.kind === "notice") {
            const glyph =
              entry.noticeKind === "retry"
                ? "↻"
                : entry.noticeKind === "compaction"
                  ? "⊙"
                  : "⚠"; // rate_limit / refusal / unknown
            return (
              <div key={entry.id} className="notice-line" data-kind={entry.noticeKind}>
                <span className="notice-glyph">{glyph}</span>
                <span>{entry.text}</span>
              </div>
            );
          }
          if (entry.kind === "bang") {
            return (
              <div key={entry.id} className="bang-block">
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
              <div key={entry.id} className="tool-group">
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
          if (entry.kind === "artifact") {
            if (pinned.includes(entry.artifactId)) {
              // Promoted to the dock; the stub holds its place in history.
              return (
                <button
                  key={entry.id}
                  className="pin-stub"
                  onClick={() => togglePin(entry.artifactId)}
                  title="Unpin — return it here"
                >
                  📌 pinned · {entry.title ?? "artifact"}
                </button>
              );
            }
            return (
              <div key={entry.id} className="turn turn-render">
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
                  key={entry.id}
                  className="pin-stub"
                  onClick={() => togglePin(entry.renderId)}
                  title="Unpin — return it here"
                >
                  📌 pinned · {entry.component}
                </button>
              );
            }
            return (
              <div key={entry.id} className="turn turn-render">
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
            <div key={entry.id} className="turn turn-user">
              <span className="glyph">❯</span> {entry.text}
            </div>
          ) : (
            <div key={entry.id} className="turn turn-assistant markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={safeAnchor}
              >
                {entry.text}
              </ReactMarkdown>
            </div>
          );
        })}
        {status && (
          <div className="status-line">
            {status.state === "tool" ? `⚙ ${status.label ?? "tool"}` : "✳ thinking…"}
          </div>
        )}
        <div ref={tail.tailRef} />
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
