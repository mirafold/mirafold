import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PromptOption } from "@protocol";
import {
  insertPromptOption,
  matchingPromptOptions,
  promptCompletionMatch,
} from "../prompt-completions";

// Phone vs. desktop is decided once at module load (a mid-session resize
// isn't worth a listener, R.4) and drives two deliberate divergences:
// the placeholder (the desktop keyboard lore wraps to three ugly lines on
// a phone; anything longer than bare "Message" clips beside the cwd crumb
// at 16px) and the SUBMIT GESTURE — see the Enter handler below.
const IS_PHONE = window.matchMedia?.("(max-width: 640px)")?.matches ?? false;
const PLACEHOLDER = IS_PHONE
  ? "Message"
  : "Enter to send · Shift+Enter for newline · !cmd runs in your shell";

// Persists the collapsible-cwd choice; anything but "hidden" means shown.
const CWD_SHOWN_KEY = "mirafold-prompt-cwd";

export function PromptBox({
  onSend,
  busy,
  onInterrupt,
  cwd,
  options,
  shortcutDisabled = false,
}: {
  onSend: (text: string) => void;
  busy: boolean;
  onInterrupt: () => void;
  // The session's working dir, shown at the prompt like a terminal's
  // `~/Projects/foo ❯`. Shell-owned — rendered here, never by agent output,
  // so it can't be spoofed (4.8).
  cwd?: string;
  options: PromptOption[];
  shortcutDisabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [activeOption, setActiveOption] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // The cwd is collapsible down to just the ❯ caret — reader's choice,
  // persisted (2026-07-16). The status bar still carries the folder leaf,
  // so a collapsed prompt never hides which project this is.
  const [cwdShown, setCwdShown] = useState(
    () => localStorage.getItem(CWD_SHOWN_KEY) !== "hidden",
  );
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCursor = useRef<number | null>(null);
  const completion = useMemo(
    () => promptCompletionMatch(text, cursor, options),
    [text, cursor, options],
  );
  const matches = useMemo(
    () => matchingPromptOptions(options, completion),
    [options, completion],
  );
  const menuOpen = !menuDismissed && matches.length > 0;
  const selectedIndex = Math.min(activeOption, Math.max(0, matches.length - 1));
  const listboxId = "prompt-options";

  // A live provider catalog can replace itself while the menu is open
  // (`commands_changed`, or Codex skills arriving after built-ins). Keep the
  // highlighted row valid across that replacement.
  useEffect(() => {
    setActiveOption((active) => Math.min(active, Math.max(0, matches.length - 1)));
  }, [matches.length]);

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

  // Restore the caret after a completion or a global trigger changes the
  // controlled textarea value.
  useLayoutEffect(() => {
    const at = pendingCursor.current;
    if (at === null) return;
    pendingCursor.current = null;
    ref.current?.setSelectionRange(at, at);
  }, [text, cursor]);

  // One reliable route back to the composer: Shift+Escape. A provider trigger
  // typed while page chrome/transcript has focus starts the prompt and opens
  // its catalog immediately. Never steal from another editable or an overlay.
  useEffect(() => {
    const onGlobalKey = (e: KeyboardEvent) => {
      if (shortcutDisabled) return;
      const target = e.target;
      // A focus-trapped card owns every key while it is open. In particular,
      // Shift+Escape must not punch through a permission/file/device dialog
      // and move the caret into inert page chrome behind it.
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      const editable =
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (editable && target !== ref.current) return;
      if (e.key === "Escape" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        ref.current?.focus();
        const at = ref.current?.value.length ?? text.length;
        ref.current?.setSelectionRange(at, at);
        setCursor(at);
        return;
      }
      if (
        (e.key === "/" || e.key === "$") &&
        options.some((option) => option.trigger === e.key) &&
        !editable &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        e.stopPropagation();
        const el = ref.current;
        const current = el?.value ?? text;
        const start = el?.selectionStart ?? current.length;
        const end = el?.selectionEnd ?? start;
        const next = current.slice(0, start) + e.key + current.slice(end);
        const nextCursor = start + 1;
        setText(next);
        setCursor(nextCursor);
        setActiveOption(0);
        setMenuDismissed(false);
        pendingCursor.current = nextCursor;
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onGlobalKey, true);
    return () => window.removeEventListener("keydown", onGlobalKey, true);
  }, [options, shortcutDisabled, text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
    setCursor(0);
    setMenuDismissed(false);
  };

  const choose = (option: PromptOption) => {
    if (!completion) return;
    const inserted = insertPromptOption(text, completion, option);
    setText(inserted.text);
    setCursor(inserted.cursor);
    setMenuDismissed(true);
    pendingCursor.current = inserted.cursor;
    ref.current?.focus();
  };

  return (
    <div className="prompt-box">
      {menuOpen && (
        <div className="prompt-options" id={listboxId} role="listbox" aria-label="Prompt options">
          {matches.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              id={`${listboxId}-${index}`}
              className={index === selectedIndex ? "is-active" : ""}
              key={`${option.trigger}:${option.value}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(option)}
              onMouseEnter={() => setActiveOption(index)}
            >
              <span className="prompt-option-value">{option.value}</span>
              {option.argumentHint && (
                <span className="prompt-option-hint">{option.argumentHint}</span>
              )}
              {option.description && (
                <span className="prompt-option-description">{option.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {/* The cwd crumb and its collapse-to-caret trick are desktop-only:
          on phone it ate a third of the typing width and the caret toggle
          isn't discoverable by touch — the folder lives in the settings
          card's Session section there instead (R.4l, Kyle 2026-07-22). */}
      {cwd && cwdShown && !IS_PHONE && (
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
      {cwd && !IS_PHONE ? (
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
        role="combobox"
        value={text}
        rows={1}
        placeholder={PLACEHOLDER}
        aria-keyshortcuts="Shift+Escape"
        aria-autocomplete="list"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? listboxId : undefined}
        aria-activedescendant={menuOpen ? `${listboxId}-${selectedIndex}` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setCursor(e.target.selectionStart);
          setActiveOption(0);
          setMenuDismissed(false);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (menuOpen && e.key === "ArrowDown") {
            e.preventDefault();
            setActiveOption((selectedIndex + 1) % matches.length);
            return;
          }
          if (menuOpen && e.key === "ArrowUp") {
            e.preventDefault();
            setActiveOption((selectedIndex - 1 + matches.length) % matches.length);
            return;
          }
          if (menuOpen && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
            e.preventDefault();
            e.stopPropagation();
            choose(matches[selectedIndex]);
            return;
          }
          if (menuOpen && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setMenuDismissed(true);
            return;
          }
          // Phone: Enter NEVER submits — it inserts a newline (the native
          // textarea behavior, deliberately left alone) and the ↑ button is
          // the one way to send, matching every mobile chat app (R.4l,
          // Kyle 2026-07-22; pinned by phone.e2e.ts). Desktop keeps
          // Enter-to-send, Shift+Enter for newline.
          if (e.key === "Enter" && !e.shiftKey && !IS_PHONE) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {busy ? (
        <button className="stop-btn" onClick={onInterrupt} title="Interrupt the turn">
          ■ esc
        </button>
      ) : (
        IS_PHONE && (
          <button
            className="prompt-send"
            onClick={submit}
            disabled={!text.trim()}
            title="Send"
            aria-label="Send message"
          >
            ↑
          </button>
        )
      )}
    </div>
  );
}
