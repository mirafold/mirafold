import { useEffect, useRef, useState } from "react";

// The shell-owned selector re-skinning interactive terminal chrome (/model,
// /effort): the arrow-key + click picker the TUI would draw, at any row
// count. NOT a registry component — the agent can't paint or grab it, and the
// registry's option caps (agent-UI discipline) don't apply here.
//
// Terminal parity: while this is the newest unanswered copy (`active`),
// ArrowUp/ArrowDown/Enter/Escape drive it globally — including while the
// caret idles in the EMPTY prompt box, exactly like the terminal where /model
// leaves you arrow-keying immediately. The moment the prompt box holds text,
// it owns its keys again. Replayed/stale copies stay click-only.
//
// Like Question, `chosen` is local mount state — it locks this copy after one
// pick; the server's action rate limit still backstops a re-mounted copy.

export type PickerRow = { label: string; detail?: string; current?: boolean; text: string };

export function PickerBlock({
  title,
  rows,
  hint,
  active,
  onPick,
}: {
  title: string;
  rows: PickerRow[];
  hint?: string;
  active: boolean;
  onPick: (text: string) => void;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(() => {
    const cur = rows.findIndex((r) => r.current);
    return cur >= 0 ? cur : 0;
  });
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const pick = (i: number) => {
    if (chosen !== null || dismissed) return;
    setChosen(i);
    setHighlight(i);
    onPick(rows[i].text);
  };

  const live = active && chosen === null && !dismissed;

  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (!["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(e.key)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        // Only the idle (empty) prompt box cedes these keys to the picker.
        const idlePrompt = t.tagName === "TEXTAREA" && (t as HTMLTextAreaElement).value === "";
        if (!idlePrompt) return;
      }
      // A picker row itself has focus: let the native button Enter fire.
      if (e.key === "Enter" && t && rowRefs.current.includes(t as HTMLButtonElement)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowUp") {
        setHighlight((h) => {
          const n = (h + rows.length - 1) % rows.length;
          rowRefs.current[n]?.scrollIntoView({ block: "nearest" });
          return n;
        });
      } else if (e.key === "ArrowDown") {
        setHighlight((h) => {
          const n = (h + 1) % rows.length;
          rowRefs.current[n]?.scrollIntoView({ block: "nearest" });
          return n;
        });
      } else if (e.key === "Enter") {
        pick(highlight);
      } else {
        setDismissed(true);
      }
    };
    // Capture phase, so the empty prompt box's own Enter handler never runs.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // `highlight` in deps keeps Enter picking what's currently lit.
  }, [live, highlight, rows.length]);

  return (
    <div className={"picker-block" + (dismissed ? " picker-dismissed" : "")}>
      <div className="picker-title">{title}</div>
      <div className="picker-rows" role="listbox" aria-label={title}>
        {rows.map((r, i) => (
          <button
            key={i}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            role="option"
            aria-selected={chosen === i || (chosen === null && r.current === true)}
            className={
              "picker-row" +
              (live && highlight === i ? " picker-highlight" : "") +
              (chosen === i ? " picker-chosen" : "")
            }
            disabled={chosen !== null || dismissed}
            onClick={() => pick(i)}
            onMouseMove={() => live && setHighlight(i)}
          >
            <span className="picker-caret" aria-hidden="true">
              {live && highlight === i ? "❯" : chosen === i ? "✓" : " "}
            </span>
            <span className="picker-label">
              {r.label}
              {r.current && <span className="picker-current"> (current)</span>}
            </span>
            {r.detail && <span className="picker-detail">{r.detail}</span>}
          </button>
        ))}
      </div>
      {hint && (
        <div className="picker-hint">
          {live ? "↑↓ to move · Enter to select · Esc to dismiss · or: " : ""}
          {hint}
        </div>
      )}
    </div>
  );
}
