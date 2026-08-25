import type { SessionMsg } from "../protocol";
import type { StoredSession } from "./session-store";

/** The one `!` process that was still open at a checkpoint boundary, if any.
 * The ring may have trimmed its start while retaining later output, so output
 * also establishes the id until a matching bang_end closes it. */
function unclosedBangId(buffer: SessionMsg[]): string | undefined {
  let open: string | undefined;
  for (const msg of buffer) {
    if (msg.type === "bang_start" || msg.type === "bang_output") open = msg.id;
    else if (msg.type === "bang_end" && msg.id === open) open = undefined;
  }
  return open;
}

/** Rebuild the browser-visible grammar at a daemon restart boundary.
 * Provider/backend restoration remains the registry's responsibility; this
 * function only copies and honestly closes the persisted transcript. */
export function recoverStoredTranscript(stored: StoredSession): {
  buffer: SessionMsg[];
  nextSeq: number;
} {
  const buffer = stored.buffer.map((msg) => ({ ...msg }));
  let nextSeq = Math.max(stored.nextSeq, (buffer[buffer.length - 1]?.seq ?? 0) + 1);
  const interruptedBang = unclosedBangId(buffer);

  if (interruptedBang) {
    buffer.push({ type: "bang_end", id: interruptedBang, exitCode: null, seq: nextSeq++ });
  }

  // A daemon cannot reattach to the middle of a provider turn. Close the
  // browser grammar honestly. A real provider normally supplied its resume
  // id before this boundary; if it did not, say that instead of implying a
  // fresh provider conversation is the old one.
  if (stored.status !== "idle") {
    const continuation =
      !stored.backend.live || stored.resumeId
        ? "the provider conversation is ready to continue."
        : "the transcript was preserved, but the provider had not supplied a resumable conversation id, so the next prompt starts a new provider conversation.";
    buffer.push({
      type: "notice",
      text: `Mirafold restarted while this ${interruptedBang ? "work" : "turn"} was running — that ${interruptedBang ? "work" : "turn"} was interrupted; ${continuation}`,
      kind: "warning",
      seq: nextSeq++,
    });
    buffer.push({ type: "turn_end", seq: nextSeq++ });
  } else if (interruptedBang) {
    buffer.push({
      type: "notice",
      text: "Mirafold restarted while a shell command was running — that command was interrupted.",
      kind: "warning",
      seq: nextSeq++,
    });
  }

  return { buffer, nextSeq };
}
