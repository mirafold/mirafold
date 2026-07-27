import { useState } from "react";
import type { ComponentProps } from "@registry-spec";

// Quoted terminal output (build logs, failing tests, stack traces) — command
// header, exit badge, and a monospace body with ANSI SGR colors rendered.
// The parser works on the plain text only: recognized color/weight codes
// become class names, every other escape sequence is stripped, and the text
// itself rides through React as text nodes — never markup.

// A pathological payload can't hang the tab: past this, the tail is dropped
// with a visible note (the head carries the command context; agents are told
// to quote excerpts).
export const CONSOLE_CLIP = 200_000;

export type AnsiSpan = { text: string; className?: string };

const FG: Record<number, string> = {
  30: "ansi-black",
  31: "ansi-red",
  32: "ansi-green",
  33: "ansi-yellow",
  34: "ansi-blue",
  35: "ansi-magenta",
  36: "ansi-cyan",
  37: "ansi-white",
  90: "ansi-bright-black",
  91: "ansi-bright-red",
  92: "ansi-bright-green",
  93: "ansi-bright-yellow",
  94: "ansi-bright-blue",
  95: "ansi-bright-magenta",
  96: "ansi-bright-cyan",
  97: "ansi-bright-white",
};

/** Strips the escape sequences we don't render: non-SGR CSI, OSC (titles,
 *  hyperlinks), and stray control bytes — keeping \n and \t. */
function stripOtherEscapes(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b./g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Splits raw terminal text into styled spans. Understood SGR codes: reset,
 *  bold, dim, and the 16 foreground colors; 256/truecolor selectors (38/48)
 *  and everything else reset nothing and render no color — their text still
 *  shows. Pure, for Tier-1. */
export function ansiSpans(raw: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let bold = false;
  let dim = false;
  let color: string | undefined;
  const push = (text: string) => {
    const clean = stripOtherEscapes(text);
    if (!clean) return;
    const classes = [color, bold ? "ansi-bold" : undefined, dim ? "ansi-dim" : undefined]
      .filter(Boolean)
      .join(" ");
    const prev = spans[spans.length - 1];
    if (prev && (prev.className ?? "") === classes) prev.text += clean;
    else spans.push(classes ? { text: clean, className: classes } : { text: clean });
  };
  const SGR = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  for (let m = SGR.exec(raw); m; m = SGR.exec(raw)) {
    push(raw.slice(last, m.index));
    last = m.index + m[0].length;
    const codes = (m[1] === "" ? "0" : m[1]).split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) (bold = false), (dim = false), (color = undefined);
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) (bold = false), (dim = false);
      else if (c === 39) color = undefined;
      else if (FG[c]) color = FG[c];
      else if (c === 38 || c === 48) {
        // 256/truecolor selector: consume its arguments, render default ink.
        i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : codes.length;
        if (c === 38) color = undefined;
      }
    }
  }
  push(raw.slice(last));
  return spans;
}

export function Console({ command, output, exitCode }: ComponentProps<"console">) {
  const [copied, setCopied] = useState(false);
  const clipped = output.length > CONSOLE_CLIP;
  const spans = ansiSpans(clipped ? output.slice(0, CONSOLE_CLIP) : output);
  return (
    <div className="rc rc-console">
      <div className="rc-console-head">
        <span className="rc-console-cmd">
          {command ? (
            <>
              <span className="glyph" aria-hidden="true">
                ❯{" "}
              </span>
              {command}
            </>
          ) : (
            "console"
          )}
        </span>
        {exitCode !== undefined && (
          <span className={`rc-console-exit rc-console-exit-${exitCode === 0 ? "ok" : "err"}`}>
            exit {exitCode}
          </span>
        )}
        <button
          className="rc-code-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(output).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="rc-console-body">
        {spans.map((s, i) =>
          s.className ? (
            <span key={i} className={s.className}>
              {s.text}
            </span>
          ) : (
            s.text
          ),
        )}
      </pre>
      {clipped && <div className="rc-console-clip">output clipped — copy shows it whole</div>}
    </div>
  );
}
