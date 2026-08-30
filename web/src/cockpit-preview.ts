import type { SessionMeta } from "@protocol";
import { visibleControls } from "./visible-controls";

/** An absent optional tail does not prove the transcript itself is empty: a
 * relay policy may withhold it, and an older daemon does not know the field. */
export function cockpitPreviewText(tail: SessionMeta["transcriptTail"]): string {
  return tail ? visibleControls(tail.text) : "No transcript preview available.";
}
