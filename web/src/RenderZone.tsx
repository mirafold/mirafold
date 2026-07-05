import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Action } from "@protocol";
import type { ZoneMsg } from "./Shell";
import { RenderBlock } from "./registry/RenderBlock";
import { PinDock } from "./PinDock";
import { ToolBlock } from "./ToolBlock";
import { Artifact } from "./Artifact";

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
      output?: string; // undefined until the result arrives
      isError?: boolean;
    }
  | {
      kind: "artifact";
      id: number;
      artifactId: string; // wire id — re-sends with this id replace the html
      html: string;
      title?: string;
    };
type Status = { state: "thinking" | "tool"; label?: string } | null;

let nextId = 0;

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
  // Pinning is pure output-zone state: renderIds in pin order. The dock
  // only exists while something is pinned (see PLAN Step 1.6).
  const [pinned, setPinned] = useState<string[]>([]);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // The text block currently receiving deltas. Kept in a ref so a user prompt
  // sent mid-stream can't detach the tail of the reply.
  const streamingId = useRef<number | null>(null);

  useEffect(
    () =>
      subscribe((msg) => {
        switch (msg.type) {
          case "user_prompt": {
            const id = nextId++;
            setEntries((es) => [
              ...es,
              { kind: "text", id, role: "user", text: msg.text, done: true },
            ]);
            setStatus({ state: "thinking" });
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
              { kind: "tool", id, toolId: msg.id, name: msg.name, detail: msg.detail },
            ]);
            break;
          }
          case "tool_result": {
            setEntries((es) =>
              es.map((e) =>
                e.kind === "tool" && e.toolId === msg.id
                  ? { ...e, output: msg.output, isError: msg.isError }
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
          case "zone_reset": {
            // A (re)attach replays the session's history from scratch.
            streamingId.current = null;
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, status]);

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
  // update-in-place render (same wire id) keeps pinned components live.
  const pinnedItems = pinned.flatMap((renderId) => {
    const entry = entries.find((e) => e.kind === "render" && e.renderId === renderId);
    return entry && entry.kind === "render" ? [entry] : [];
  });

  return (
    <div className="zone-row">
      <div className="render-zone">
        {entries.map((entry) => {
          if (entry.kind === "tool") {
            return (
              <ToolBlock
                key={entry.id}
                name={entry.name}
                detail={entry.detail}
                output={entry.output}
                isError={entry.isError}
              />
            );
          }
          if (entry.kind === "artifact") {
            return (
              <div key={entry.id} className="turn turn-render">
                <Artifact html={entry.html} title={entry.title} />
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
                components={{
                  a: ({ node: _node, ...props }) => (
                    <a {...props} target="_blank" rel="noopener noreferrer" />
                  ),
                }}
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
        <div ref={bottomRef} />
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
