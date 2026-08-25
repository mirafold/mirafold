import { useCallback, useRef, useState } from "react";

// Screen-reader announcements. The design decision worth knowing:
// streaming output is NOT announced as it arrives. An aria-live region on the
// transcript re-reads or interrupts itself on every token, which is unusable.
// So the transcript stays silent (RenderZone: role="log" + aria-live="off" —
// navigable and readable on demand) and these two regions speak only at
// semantic boundaries: polite for turn progress, assertive for what must
// interrupt (permission prompts, errors, a dropped socket).
//
// Shell-owned, like every other affordance that reports on the agent — agent
// output never reaches these regions except as the text it already streamed.
//
// The two-slot alternation is load-bearing, not decoration: a live region
// announces on DOM change, so the same message twice in a turn ("Running
// Read") would be silent the second time if it landed in the same node.
// Successive messages alternate slots, so every announcement is a change.

export type Announcement = { text: string; urgent: boolean; seq: number };

// The response is banked as raw markdown (text_delta), but the transcript is
// what renders it — this region only speaks it. Read aloud, the raw source
// voices its own syntax: "pound pound Code review", "bar bar", "backtick",
// every list dash. So the markers are stripped to the prose they wrap before
// it's spoken; the visible transcript (rendered, navigable) is untouched.
export function speechFromMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    let line = raw;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence; // drop the fence marker itself, keep the code lines
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // A table separator row (|---|:--:|) carries no words — drop it whole.
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)) continue;
    // A horizontal rule is decoration.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    line = line.replace(/^\s{0,3}#{1,6}\s+/, ""); // heading markers
    line = line.replace(/^\s*>+\s?/, ""); // blockquote markers
    line = line.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, "$1"); // task checkboxes
    line = line.replace(/^(\s*)[-*+]\s+/, "$1"); // bullet markers
    line = line.replace(/^(\s*)\d+[.)]\s+/, "$1"); // ordered markers
    line = line.replace(/\s*\|\s*/g, ", ").replace(/^,\s*|,\s*$/g, ""); // table cells
    out.push(line);
  }
  return (
    out
      .join("\n")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> link text
      .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
      .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2") // italic
      .replace(/`+([^`]+)`+/g, "$1") // inline code
      .replace(/[ \t]+\n/g, "\n") // trailing spaces
      .replace(/\n{3,}/g, "\n\n") // collapse blank runs
      .trim()
  );
}

// What a screen reader hears when the turn lands. The whole response, once —
// but capped: a turn that dumps a long file would otherwise read for minutes
// with no way to skim, and the transcript is right there to navigate. A turn
// that produced only tool work has no prose, hence the fallback.
const SPOKEN_RESPONSE_CAP = 4000;
export function turnResponse(text: string): string {
  const t = speechFromMarkdown(text);
  if (!t) return "Turn complete.";
  if (t.length <= SPOKEN_RESPONSE_CAP) return t;
  return `${t.slice(0, SPOKEN_RESPONSE_CAP)}… Response truncated for reading; the full text is in the transcript.`;
}

export function useAnnouncer() {
  const [message, setMessage] = useState<Announcement | null>(null);
  const seq = useRef(0);
  const announce = useCallback((text: string, urgent = false) => {
    const t = text.trim();
    if (!t) return;
    seq.current += 1;
    setMessage({ text: t, urgent, seq: seq.current });
  }, []);
  return { message, announce };
}

function Slots({ message }: { message: Announcement | null }) {
  const even = message && message.seq % 2 === 0 ? message.text : "";
  const odd = message && message.seq % 2 === 1 ? message.text : "";
  return (
    <>
      <span>{even}</span>
      <span>{odd}</span>
    </>
  );
}

export function Announcer({ message }: { message: Announcement | null }) {
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        <Slots message={message && !message.urgent ? message : null} />
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        <Slots message={message && message.urgent ? message : null} />
      </div>
    </>
  );
}
