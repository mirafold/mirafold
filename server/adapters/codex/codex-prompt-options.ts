import type { PromptOption } from "../../protocol";

// Codex's SDK does not expose the TUI's client-side command dispatcher. Only
// advertise the commands Mirafold intercepts and re-skins itself (codex.ts
// handles both); every other TUI command would otherwise be sent to the model
// as ordinary prompt text.
export function codexSlashOptions(): PromptOption[] {
  return [
    {
      trigger: "/",
      value: "/model",
      label: "model",
      description: "choose what model to use",
      kind: "command",
    },
    {
      trigger: "/",
      value: "/effort",
      label: "effort",
      description: "choose the reasoning effort",
      kind: "command",
    },
  ];
}
