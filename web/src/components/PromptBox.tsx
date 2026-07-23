import { useEffect, useLayoutEffect, useRef, useState } from "react";

// The desktop placeholder is keyboard lore that wraps to three ugly
// lines on a phone — narrow viewports get the short form (bare "Message":
// anything longer clips mid-word beside the cwd crumb at 16px, R.4l).
// Checked once at module load: a mid-session resize isn't worth a listener (R.4).
const PLACEHOLDER = window.matchMedia?.("(max-width: 640px)")?.matches
  ? "Message"
  : "Enter to send · Shift+Enter for newline · !cmd runs in your shell";

// Persists the collapsible-cwd choice; anything but "hidden" means shown.
const CWD_SHOWN_KEY = "mirafold-prompt-cwd";

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
  // The cwd is collapsible down to just the ❯ caret — reader's choice,
  // persisted (2026-07-16). The status bar still carries the folder leaf,
  // so a collapsed prompt never hides which project this is.
  const [cwdShown, setCwdShown] = useState(
    () => localStorage.getItem(CWD_SHOWN_KEY) !== "hidden",
  );
  const ref = useRef<HTMLTextAreaElement>(null);

  const toggleCwd = () => {
    setCwdShown((shown) => {
      localStorage.setItem(CWD_SHOWN_KEY, shown ? "hidden" : "shown");
      return !shown;
    });
  };

  // The caret starts in the prompt box, so entering a session (new or
  // existing) means you can just type — no click first (2026-07-20, Kyle).
  // Re-taken when a turn ends, because ending it unmounts whatever the user
  // last clicked (the stop button, a permission answer) and drops focus to
  // the body. Two things are left alone: focus that something else holds —
  // an overlay (onboarding, settings, connect-device) keeps it, since yanking
  // focus out of a modal is worse than the click it saves — and a live
  // selection, which focusing a textarea would collapse just as the reader
  // was copying out of the transcript.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (window.getSelection()?.isCollapsed === false) return;
    ref.current?.focus();
  }, [busy]);

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
      {cwd && cwdShown && (
        <button
          type="button"
          className="prompt-cwd"
          title={`${cwd} \u2014 click to hide (the caret brings it back)`}
          onClick={toggleCwd}
        >
          {/* LRM sentinels: the button is direction:rtl for a left-side
              ellipsis; these keep the path itself in LTR order. */}
          {"\u200E" + cwd + "\u200E"}
        </button>
      )}
      {cwd ? (
        <button
          type="button"
          className="glyph prompt-caret"
          title={cwdShown ? "Hide the working directory" : `${cwd} — click to show`}
          onClick={toggleCwd}
        >
          ❯
        </button>
      ) : (
        <span className="glyph">❯</span>
      )}
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
