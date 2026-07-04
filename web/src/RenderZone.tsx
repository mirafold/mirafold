import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentName } from "@registry-spec";
import type { ZoneMsg } from "./Shell";
import { registry } from "./registry";

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
}: {
  subscribe: (l: (m: ZoneMsg) => void) => () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<Status>(null);
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
          case "status":
            setStatus({ state: msg.state, label: msg.label });
            break;
          case "turn_end": {
            setStatus(null);
            const id = streamingId.current;
            streamingId.current = null;
            if (id !== null) {
              setEntries((es) =>
                es.map((e) => (e.kind === "text" && e.id === id ? { ...e, done: true } : e)),
              );
            }
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
        }
      }),
    [subscribe],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, status]);

  return (
    <div className="render-zone">
      {entries.map((entry) => {
        if (entry.kind === "render") {
          // Dynamic dispatch erases the per-component prop typing; props are
          // trusted here and validated in Step 1.4.
          const Component = registry[entry.component as ComponentName] as
            | React.ComponentType<Record<string, unknown>>
            | undefined;
          if (!Component) return null; // unknown component — graceful fallback is Step 1.4
          return (
            <div key={entry.id} className="turn turn-render">
              <Component {...entry.props} />
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
  );
}
