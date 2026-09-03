import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { PromptOption } from "@protocol";
import {
  insertPromptOption,
  matchingPromptOptions,
  promptCompletionMatch,
} from "../input/prompt-completions";
import { mergePromptDraft } from "../input/prompt-draft";
import { useIsPhone } from "../hooks/use-is-phone";
import {
  PhoneInputNavigation,
  type PhoneInputNavigationModel,
} from "./InputNavigation";

// Persists the collapsible-cwd choice; anything but "hidden" means shown.
const CWD_SHOWN_KEY = "mirafold-prompt-cwd";
const PROMPT_OPTIONS_ID = "prompt-options";

function promptSourceLabel(option: PromptOption): string | undefined {
  switch (option.source) {
    case "claude-code":
      return "Claude Agent command";
    case "codex":
      return option.kind === "skill" ? "Codex skill" : "Codex command";
    case "gemini-cli":
      return "Gemini CLI command";
    case "opencode":
      return "OpenCode command";
    case "mirafold":
      return "Mirafold demo";
    default:
      return undefined;
  }
}

type PromptBoxProps = {
  onSend: (text: string) => void;
  busy: boolean;
  onInterrupt: () => void;
  // The bang shell's current working dir, shown at the prompt like a terminal's
  // `~/Projects/foo ❯`. Shell-owned — rendered here, never by agent output,
  // so it can't be spoofed.
  cwd?: string;
  options: PromptOption[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  containerRef?: RefObject<HTMLDivElement | null>;
  draft?: PromptDraft;
  globalTriggersDisabled?: boolean;
  onNavigateLatestInput?: () => boolean;
  inputNavigation?: PhoneInputNavigationModel;
};

export type PromptDraft = { id: number; text: string };

function PromptOptionsMenu({
  options,
  selectedIndex,
  onChoose,
  onActive,
}: {
  options: PromptOption[];
  selectedIndex: number;
  onChoose: (option: PromptOption) => void;
  onActive: (index: number) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keyboard selection must remain visible inside the listbox. Adjust only
  // this menu's own scrollTop: scrollIntoView() can also move the transcript
  // page, which would be surprising while the user is reading above.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const active = activeRef.current;
    if (!menu || !active) return;
    const menuRect = menu.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < menuRect.top) {
      menu.scrollTop += activeRect.top - menuRect.top;
    } else if (activeRect.bottom > menuRect.bottom) {
      menu.scrollTop += activeRect.bottom - menuRect.bottom;
    }
  }, [selectedIndex, options]);

  return (
    <div
      ref={menuRef}
      className="prompt-options"
      id={PROMPT_OPTIONS_ID}
      role="listbox"
      aria-label="Prompt options"
    >
      {options.map((option, index) => (
        <button
          ref={index === selectedIndex ? activeRef : undefined}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          id={`${PROMPT_OPTIONS_ID}-${index}`}
          className={index === selectedIndex ? "is-active" : ""}
          key={`${option.trigger}:${option.value}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(option)}
          onMouseEnter={() => onActive(index)}
        >
          <span className="prompt-option-value">{option.value}</span>
          {option.argumentHint && (
            <span className="prompt-option-hint">{option.argumentHint}</span>
          )}
          {(option.source || option.description) && (
            <span className="prompt-option-meta">
              {promptSourceLabel(option) && (
                <span className="prompt-option-source">{promptSourceLabel(option)}</span>
              )}
              {option.description && (
                <span className="prompt-option-description">{option.description}</span>
              )}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function PromptBox({
  onSend,
  busy,
  onInterrupt,
  cwd,
  options,
  textareaRef: ref,
  containerRef,
  draft,
  globalTriggersDisabled = false,
  onNavigateLatestInput,
  inputNavigation,
}: PromptBoxProps) {
  // Phone drives two deliberate divergences: the placeholder (the desktop
  // keyboard lore wraps to three ugly lines on a phone; anything longer than
  // bare "Message" clips beside the cwd crumb at 16px) and the SUBMIT
  // GESTURE — see the Enter handler below.
  const phone = useIsPhone();
  const placeholder = phone
    ? "Message"
    : "Enter to send · Shift+Enter for newline · !cmd runs in your shell";
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [activeOption, setActiveOption] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // The cwd is collapsible down to just the ❯ caret — reader's choice,
  // persisted. The status bar still carries the folder leaf,
  // so a collapsed prompt never hides which project this is.
  const [cwdShown, setCwdShown] = useState(
    () => localStorage.getItem(CWD_SHOWN_KEY) !== "hidden",
  );
  const pendingCursor = useRef<number | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
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
  // existing) means you can just type — no click first.
  // Re-taken when a turn ends, because ending it unmounts whatever the user
  // last clicked (the stop button, a permission answer) and drops focus to
  // the body. Two things are left alone: focus that something else holds —
  // an overlay (agent picker, settings, connect-device) keeps it, since yanking
  // focus out of a modal is worse than the click it saves — and a live
  // selection, which focusing a textarea would collapse just as the reader
  // was copying out of the transcript.
  useEffect(() => {
    // A phone navigation tap can legitimately leave BODY focused, especially
    // when its destination button becomes disabled at an endpoint. A turn
    // ending must not use that as a reason to close the card and summon the
    // software keyboard.
    if (phone && inputNavigation?.open) return;
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
    ref.current?.focus({ preventScroll: true });
  }, [text, cursor]);

  // Review actions can only propose text. Merge it after anything the user
  // was already composing, show it in this trusted textarea, and leave the
  // ordinary edit/send path entirely in the user's hands.
  useEffect(() => {
    if (!draft) return;
    const next = mergePromptDraft(textRef.current, draft.text);
    textRef.current = next;
    setText(next);
    setCursor(next.length);
    setActiveOption(0);
    setMenuDismissed(true);
    pendingCursor.current = next.length;
  }, [draft]);

  // A provider trigger typed while page chrome/transcript has focus starts the
  // prompt and opens its catalog immediately. Never steal from another
  // editable or an overlay.
  useEffect(() => {
    const onGlobalKey = (e: KeyboardEvent) => {
      if (globalTriggersDisabled) return;
      const target = e.target;
      // A focus-trapped card owns every key while it is open. Provider
      // triggers must not punch through a permission/file/device dialog and
      // move the caret into inert page chrome behind it.
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      const editable =
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (editable && target !== ref.current) return;
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
  }, [options, globalTriggersDisabled, text]);

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
    <div className="prompt-box" ref={containerRef}>
      {menuOpen && (
        <PromptOptionsMenu
          options={matches}
          selectedIndex={selectedIndex}
          onChoose={choose}
          onActive={setActiveOption}
        />
      )}
      {/* The cwd crumb and its collapse-to-caret trick are desktop-only:
          on phone it ate a third of the typing width and the caret toggle
          isn't discoverable by touch — the folder lives in the settings
          card's Session section there instead. */}
      {cwd && cwdShown && !phone && (
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
      {cwd && !phone ? (
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
        placeholder={placeholder}
        aria-autocomplete="list"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? PROMPT_OPTIONS_ID : undefined}
        aria-activedescendant={menuOpen ? `${PROMPT_OPTIONS_ID}-${selectedIndex}` : undefined}
        onFocus={inputNavigation?.onClose}
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
          if (
            !phone &&
            e.key === "ArrowUp" &&
            text.length === 0 &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.metaKey &&
            !e.shiftKey &&
            onNavigateLatestInput?.()
          ) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          // Phone: Enter NEVER submits — it inserts a newline (the native
          // textarea behavior, deliberately left alone) and the ↑ button is
          // the one way to send, matching every mobile chat app (pinned
          // by phone.e2e.ts). Desktop keeps
          // Enter-to-send, Shift+Enter for newline.
          if (e.key === "Enter" && !e.shiftKey && !phone) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {busy ? (
        <button
          className="stop-btn"
          onClick={onInterrupt}
          title="Stop active model and shell work (the session stays warm)"
        >
          ■ esc
        </button>
      ) : (
        phone && (
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
      {phone && inputNavigation && (
        <PhoneInputNavigation navigation={inputNavigation} completionOpen={menuOpen} />
      )}
    </div>
  );
}
