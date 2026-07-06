// Wire protocol — the contract between server and browser.
// Later phases ADD message types; existing shapes never change.
// The web side imports these same types via the `@protocol` alias.

/**
 * The terminal agents genui-shell can re-skin (one adapter each). On the wire
 * since Phase P.4 — the browser picks which agent a session runs at onboarding,
 * so the name is part of the shared contract (adapters/types.ts re-exports it).
 */
export type AgentName = "claude-code" | "codex" | "gemini-cli";

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
  // T2.2 widens it with the FULL input (optional — old clients ignore it);
  // the client renders Edit/Write inputs as diffs/code, the rest as JSON.
  // T2.4: `parentId`, when set, is the Task tool_use id this call belongs to —
  // a subagent's call, which the client nests under its owning Task row.
  | {
      type: "tool_use";
      name: string;
      detail?: string;
      id: string;
      input?: Record<string, unknown>;
      parentId?: string;
    }
  // T2.3: `truncatedBytes`, when set, is how many UTF-8 bytes were elided
  // after the cap — the client shows an explicit marker rather than cutting
  // silently. Optional/additive. T2.4: `parentId` as on tool_use.
  | {
      type: "tool_result";
      output: string;
      isError?: boolean;
      id: string;
      truncatedBytes?: number;
      parentId?: string;
    }
  // Phase T.3: the turn is paused on a gated tool call until the browser
  // answers (or the server times out to deny). Drawn by the trusted shell.
  | { type: "permission_request"; tool: string; detail: string; id: string }
  // Phase 4.2: the server's echo of a user turn. User strips come off the
  // wire (not a local echo) so every attached viewport — and the replay
  // buffer — carries them identically.
  | { type: "user_prompt"; text: string }
  // Phase 4.2: reply to attach/create — which session this viewport is on.
  // Phase P.4 adds `agent` (optional/additive): which terminal agent is behind
  // the session, so the status bar can name it.
  | { type: "session_created"; sessionId: string; cwd: string; agent?: AgentName }
  // Phase P.4: on connect, the server advertises which agents this daemon can
  // run and which have credentials (`live`) — the onboarding picker's source.
  // No agent is assumed; `default` is only a hint for pre-selection.
  // Step 4.8 adds (optional/additive): `cwd` — the directory the daemon was
  // launched from, i.e. the default working dir for new sessions (terminal
  // parity) — and `home`, so the client can render paths in ~-form. Neither
  // is a secret: the daemon is local and the browser is the same user.
  | {
      type: "agents";
      agents: { agent: AgentName; live: boolean }[];
      default: AgentName;
      cwd?: string;
      home?: string;
    }
  // Phase 3: agent-authored HTML for the sandboxed iframe host (the ONLY
  // channel raw agent markup may travel). Re-sending an id replaces that
  // artifact in place — same rule as `render`.
  | { type: "artifact"; html: string; id: string; title?: string }
  // T2.6: per-turn token/cost accounting for the shell's status bar. One
  // per completed turn (just before turn_end); the client sums for the
  // session total. Replay-safe — buffered like everything else.
  | {
      type: "usage";
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    }
  // Phase T2.1: the model's reasoning stream, full fidelity. Renders as a
  // dim block that folds to one line once the turn's real output starts —
  // collapse-on-finalize, never dropped.
  | { type: "thinking_delta"; text: string };

/**
 * Phase 2: the complete vocabulary of what a component interaction may do.
 * Carried inside render props as {label, action} descriptors; the client
 * never makes an arbitrary call — prompt/tool actions round-trip through
 * the server, state actions touch output-zone state only (never sent).
 */
export type Action =
  | { kind: "prompt"; text: string }
  | { kind: "tool"; name: string; args?: Record<string, unknown> }
  | { kind: "state"; op: "pin" | "unpin"; renderId: string };

/** Browser → server */
export type ClientMsg =
  | { type: "prompt"; text: string }
  // Phase T.2: halt the in-flight turn (the session stays warm).
  | { type: "interrupt" }
  // Phase T.3: the user's answer to a permission_request.
  | { type: "permission_response"; id: string; allow: boolean }
  // Phase 4.2: a connection is a viewport onto a registry session. attach
  // joins an existing session (stale ids fall back to create); create
  // starts a fresh one, optionally in a specific working dir.
  | { type: "attach"; sessionId: string }
  // Phase P.4: `agent` names which terminal agent to run (chosen at onboarding);
  // omitted → the daemon's default. Credentials stay server-side, never sent.
  | { type: "create"; cwd?: string; agent?: AgentName }
  // Phase 2: a component interaction, attributed to the render block
  // (sourceId = its render id) that emitted it.
  | { type: "action"; action: Action; sourceId: string };
