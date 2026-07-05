import { useLayoutEffect, useRef, useState } from "react";

export function PromptBox({
  onSend,
  busy,
  onInterrupt,
}: {
  onSend: (text: string) => void;
  busy: boolean;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: track content height up to the CSS max-height, after which
  // the textarea scrolls internally (the scrollbar is the "there's more" cue).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="prompt-box">
      <span className="glyph">❯</span>
      <textarea
        ref={ref}
        value={text}
        rows={1}
        placeholder="Enter to send · Shift+Enter for newline"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {busy && (
        <button className="stop-btn" onClick={onInterrupt} title="Interrupt the turn">
          ■ esc
        </button>
      )}
    </div>
  );
}
