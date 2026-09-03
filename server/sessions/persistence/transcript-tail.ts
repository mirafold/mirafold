import type { SessionMsg } from "../../protocol";

/** A fleet snapshot is a doorbell-sized view, not a second replay stream. */
export const TRANSCRIPT_TAIL_MAX_CHARS = 1_200;

export type TranscriptTail = { text: string; truncated?: true };

/**
 * The text-only parts of one transcript record. Structured paintings stay
 * represented by a short inert label; no HTML or render props enter shell
 * chrome. The same function decides whether a live record warrants a fresh
 * preview snapshot.
 */
function transcriptSegment(msg: SessionMsg): string | undefined {
  switch (msg.type) {
    case "user_prompt":
      return `\n❯ ${msg.text}\n`;
    case "text_delta":
    case "thinking_delta":
      return msg.text;
    case "tool_use":
      return `\n[${msg.name}${msg.detail ? ` · ${msg.detail}` : ""}]\n`;
    case "tool_result": {
      const elided = msg.truncatedBytes
        ? `⋯ ${msg.truncatedBytes} ${msg.truncatedBytes === 1 ? "byte" : "bytes"} elided`
        : "";
      const visible = [msg.output, elided].filter(Boolean).join("\n");
      return visible ? `\n${visible}\n` : undefined;
    }
    case "permission_request":
      return `\n[permission · ${msg.tool}]\n`;
    case "error":
      return `\n[error] ${msg.message}\n`;
    case "render":
      return `\n[${msg.component} painting]\n`;
    case "picker":
      return `\n[${msg.title}]\n`;
    case "artifact":
      return `\n[${msg.title ?? "artifact"}]\n`;
    case "notice":
      return `\n${msg.source ? `[${msg.source}] ` : ""}${msg.text}\n`;
    case "bang_start":
      return `\n${msg.silent ? "!!" : "!"} ${msg.command}\n`;
    case "bang_output":
      return msg.data;
    case "bang_end":
      return `\n[${msg.exitCode === null ? "killed" : msg.exitCode === 0 ? "done" : `exit ${msg.exitCode}`}]\n`;
    default:
      return undefined;
  }
}

function safeUtf16Tail(text: string, max: number): string {
  if (text.length <= max) return text;
  let tail = text.slice(-max);
  // Do not put half a UTF-16 surrogate on the wire when the cap lands inside
  // one astral character.
  if (/^[\uDC00-\uDFFF]/u.test(tail)) tail = tail.slice(1);
  return tail;
}

/**
 * Build a bounded, plain-text tail without joining the replay ring first.
 * Rings can retain tens of megabytes; walking backward stops as soon as the
 * small preview budget is full.
 */
export function transcriptTail(
  messages: readonly SessionMsg[],
  maxChars = TRANSCRIPT_TAIL_MAX_CHARS,
): TranscriptTail | undefined {
  if (!Number.isInteger(maxChars) || maxChars <= 0) return undefined;
  const reversedSegments: string[] = [];
  let keptChars = 0;
  let truncated = false;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const segment = transcriptSegment(messages[i]);
    if (!segment) continue;
    const remaining = maxChars - keptChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (segment.length > remaining) {
      reversedSegments.push(safeUtf16Tail(segment, remaining));
      truncated = true;
      break;
    }
    reversedSegments.push(segment);
    keptChars += segment.length;
  }

  const text = reversedSegments.reverse().join("").trim();
  if (!text) return undefined;
  return { text, ...(truncated ? { truncated: true as const } : {}) };
}

export function changesTranscriptTail(msg: SessionMsg): boolean {
  return Boolean(transcriptSegment(msg));
}
