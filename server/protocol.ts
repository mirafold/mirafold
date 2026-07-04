// Wire protocol — the contract between server and browser.
// Later phases ADD message types; existing shapes never change.
// The web side imports these same types via the `@protocol` alias.

/** Server → browser */
export type WireMsg =
  | { type: "text_delta"; text: string }
  | { type: "status"; state: "thinking" | "tool"; label?: string }
  | { type: "turn_end" }
  | { type: "error"; message: string };
// Phase 1 adds:  { type: "render"; component: string; props: object; id: string }
// Phase 3 adds:  { type: "artifact"; html: string; id: string }

/** Browser → server */
export type ClientMsg = { type: "prompt"; text: string };
// Phase 2 adds:  { type: "action"; action: Action; sourceId: string }
