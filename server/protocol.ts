// Wire protocol — the contract between server and browser.
// Later phases ADD message types; existing shapes never change.
// The web side imports these same types via the `@protocol` alias.

/** Server → browser */
export type WireMsg =
  | { type: "text_delta"; text: string }
  | { type: "status"; state: "thinking" | "tool"; label?: string }
  | { type: "turn_end" }
  | { type: "error"; message: string }
  // "Show component X with props P." `component` is a plain string on the
  // wire (not keyof the registry spec) so an unknown/malformed instruction is
  // still representable and can degrade gracefully client-side (Step 1.4).
  // Re-sending an already-seen `id` updates that component's props in place —
  // the mechanism that keeps pinned widgets live (Step 1.6).
  | { type: "render"; component: string; props: Record<string, unknown>; id: string }
  // Phase T.1: the transcript record of a tool call. `tool_use` announces the
  // call (detail = its one human-salient argument, e.g. the bash command);
  // a later `tool_result` with the same id completes that record.
  | { type: "tool_use"; name: string; detail?: string; id: string }
  | { type: "tool_result"; output: string; isError?: boolean; id: string };
// Phase 3 adds:  { type: "artifact"; html: string; id: string }

/** Browser → server */
export type ClientMsg =
  | { type: "prompt"; text: string }
  // Phase T.2: halt the in-flight turn (the session stays warm).
  | { type: "interrupt" };
// Phase 2 adds:  { type: "action"; action: Action; sourceId: string }
