import { randomUUID } from "node:crypto";
import type { WireMsg } from "../protocol";

// The /model picker re-skin shared by the codex and gemini adapters (V.2):
// the engine's own catalog painted as a clickable `question` component — a
// click sends `clickText(id)` back through the adapter's /model path — or as
// a plain `list` + `switchHint` when the catalog leaves the question
// component's 2–4 option range.

export type ModelPickerRow = {
  id: string;
  displayName: string;
  description: string;
  current: boolean;
};

export function emitModelPicker(
  emit: (msg: WireMsg) => void,
  rows: ModelPickerRow[],
  opts: { clickText: (id: string) => string; switchHint: string },
) {
  if (rows.length >= 2 && rows.length <= 4) {
    emit({
      type: "render",
      component: "question",
      props: {
        question: "Select a model",
        options: rows.map((m) => ({
          label: m.current ? `${m.displayName} (current)` : m.displayName,
          text: opts.clickText(m.id),
          detail: m.description,
        })),
      },
      id: randomUUID(),
    });
  } else {
    emit({
      type: "render",
      component: "list",
      props: {
        title: "Models",
        items: rows.map((m) => ({
          text: `**${m.displayName}**${m.current ? " (current)" : ""} — \`${m.id}\``,
          detail: m.description,
        })),
      },
      id: randomUUID(),
    });
    emit({ type: "text_delta", text: opts.switchHint });
  }
}
