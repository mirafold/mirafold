import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ZoneMsg } from "./Shell";

type Turn = { id: number; role: "user" | "assistant"; text: string; done: boolean };
type Status = { state: "thinking" | "tool"; label?: string } | null;

let nextId = 0;

/**
 * The output zone — an interpreter for the wire protocol. Level 1: streamed
 * text accumulates into the current assistant turn and renders as sanitized
 * markdown (react-markdown never emits raw HTML from the source).
 */
export function RenderZone({
  subscribe,
}: {
  subscribe: (l: (m: ZoneMsg) => void) => () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<Status>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // The assistant turn currently receiving deltas. Kept out of `turns` so a
  // user prompt sent mid-stream can't detach the tail of the reply.
  const streamingId = useRef<number | null>(null);

  useEffect(
    () =>
      subscribe((msg) => {
        switch (msg.type) {
          case "user_prompt": {
            const id = nextId++;
            setTurns((t) => [...t, { id, role: "user", text: msg.text, done: true }]);
            setStatus({ state: "thinking" });
            break;
          }
          case "text_delta": {
            setStatus(null);
            const id = streamingId.current;
            if (id !== null) {
              setTurns((t) =>
                t.map((turn) => (turn.id === id ? { ...turn, text: turn.text + msg.text } : turn)),
              );
            } else {
              const newId = nextId++;
              streamingId.current = newId;
              setTurns((t) => [...t, { id: newId, role: "assistant", text: msg.text, done: false }]);
            }
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
              setTurns((t) => t.map((turn) => (turn.id === id ? { ...turn, done: true } : turn)));
            }
            break;
          }
          case "error": {
            setStatus(null);
            const id = nextId++;
            setTurns((t) => [
              ...t,
              { id, role: "assistant", text: `**Error:** ${msg.message}`, done: true },
            ]);
            break;
          }
        }
      }),
    [subscribe],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, status]);

  return (
    <div className="render-zone">
      {turns.map((turn) =>
        turn.role === "user" ? (
          <div key={turn.id} className="turn turn-user">
            <span className="glyph">❯</span> {turn.text}
          </div>
        ) : (
          <div key={turn.id} className="turn turn-assistant markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                a: ({ node: _node, ...props }) => (
                  <a {...props} target="_blank" rel="noopener noreferrer" />
                ),
              }}
            >
              {turn.text}
            </ReactMarkdown>
          </div>
        ),
      )}
      {status && (
        <div className="status-line">
          {status.state === "tool" ? `⚙ ${status.label ?? "tool"}` : "✳ thinking…"}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
