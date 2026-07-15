import { useLayoutEffect, useRef, useState } from "react";

// The desktop placeholder is keyboard lore that wraps to three ugly
// lines on a phone — narrow viewports get the short form. Checked once at
// module load: a mid-session resize isn't worth a listener (R.4).
const PLACEHOLDER = window.matchMedia?.("(max-width: 640px)")?.matches
  ? "Message · !cmd runs in your shell"
  : "Enter to send · Shift+Enter for newline · !cmd runs in your shell";

export function PromptBox({
  onSend,
  busy,
  onInterrupt,
  cwd,
}: {
  onSend: (text: string) => void;
  busy: boolean;
  onInterrupt: () => void;
  // The session's working dir, shown at the prompt like a terminal's
  // `~/Projects/foo ❯`. Shell-owned — rendered here, never by agent output,
  // so it can't be spoofed (4.8).
  cwd?: string;
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
      {cwd && (
        <span className="prompt-cwd" title={cwd}>
          {/* LRM sentinels: the span is direction:rtl for a left-side
              ellipsis; these keep the path itself in LTR order. */}
          {"\u200E" + cwd + "\u200E"}
        </span>
      )}
      <span className="glyph">❯</span>
      <textarea
        ref={ref}
        value={text}
        rows={1}
        placeholder={PLACEHOLDER}
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
