import { useState } from "react";

export function PromptBox({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");

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
    </div>
  );
}
