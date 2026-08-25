import { randomUUID } from "node:crypto";
import type { WireMsg } from "../protocol";

// The /model picker re-skin shared by the codex and gemini adapters: the
// engine's own catalog painted as ONE shell-owned `picker` wire message —
// arrow-key + click selection at any row count. Choosing a row sends
// `clickText(id)` back through the adapter's /model path; `switchHint` rides
// along as the typed alternative. (Not a question component: the registry's
// caps are discipline on agent-generated UI and must never bind a shell
// re-skin.)

export type ModelPickerRow = {
  id: string;
  displayName: string;
  description: string;
  current: boolean;
};

export function emitModelPicker(
  emit: (msg: WireMsg) => void,
  rows: ModelPickerRow[],
  opts: {
    clickText: (id: string) => string;
    switchHint: string;
    // What's being picked, for the picker's heading. Defaults preserve the
    // original model wording; the /effort re-skin passes effort labels.
    question?: string;
  },
) {
  emit({
    type: "picker",
    id: randomUUID(),
    title: opts.question ?? "Select a model",
    rows: rows.map((m) => ({
      label: m.displayName,
      detail: m.description || undefined,
      current: m.current || undefined,
      text: opts.clickText(m.id),
    })),
    hint: opts.switchHint,
  });
}
