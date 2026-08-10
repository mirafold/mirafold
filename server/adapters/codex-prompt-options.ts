import type { PromptOption } from "../protocol";

// Codex's SDK does not expose the TUI's client-side command dispatcher. Only
// advertise the command Mirafold faithfully re-skins itself; every other TUI
// command would otherwise be sent to the model as ordinary prompt text.
export function codexSlashOptions(): PromptOption[] {
  return [
    {
      trigger: "/",
      value: "/model",
      label: "model",
      description: "choose what model to use",
      kind: "command",
    },
  ];
}
