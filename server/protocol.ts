// Wire protocol — the contract between server and browser.
// Later phases ADD message types; existing shapes never change.
// The web side imports these same types via the `@protocol` alias.
//
// The flip side of additive-only, stated as a RULE (R.4h, tested in
// ws.test.ts and session.itest.ts): both ends IGNORE unknown message types —
// no error, no close. That's what lets an old client face a new daemon (and
// vice versa once the relay puts them on different release trains). The
// client must still honor `seq` on unknown broadcast types, or resume would
// re-replay frames it already saw. Same spirit one layer up: the client
// validates render props with the tolerant clientSchemas (unknown keys
// strip) and shows unknown agent names as raw strings.

/**
 * The terminal agents Mirafold can re-skin (one adapter each). On the wire
 * since Phase P.4 — the browser picks which agent a session runs at onboarding,
 * so the name is part of the shared contract (adapters/types.ts re-exports it).
 */
export type AgentName = "claude-code" | "codex" | "gemini-cli";

/**
 * Server → browser.
 * Step 4.4 (additive): every message BROADCAST onto a session's stream also
 * carries `seq?: number` — a session-scoped, strictly increasing sequence
 * number stamped by the registry (see the intersection on the union below).
 * A reconnecting viewport sends the last seq it saw (`attach.afterSeq`) and
 * the server replays only the tail — resume without a repaint. Per-viewport
 * messages (session_created, agents, pong) carry no seq: they're connection
 * plumbing, not session history.
 */
export type WireMsg = WireMsgBody & { seq?: number };

type WireMsgBody =
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
  // the session, so the status bar can name it. Step 4.4 adds `resumed`: true
  // means the server honored `attach.afterSeq` and will replay only the tail —
  // the client keeps its state and must NOT reset the zone; absent/false means
  // a full replay follows. Step R.4b adds `demo` (optional/additive): true
  // means the agent had no credentials and this session runs the scripted
  // mock — the shell draws a persistent demo banner the agent can't fake or
  // clear (same trust rule as the permission bar). Step R.4c adds `fallback`
  // (optional/additive): true means the viewport asked to attach to a
  // session this registry doesn't have (daemon restarted, session expired)
  // and got a FRESH one instead — the shell must say so, never silently
  // swap the URL over a blank transcript.
  | {
      type: "session_created";
      sessionId: string;
      cwd: string;
      agent?: AgentName;
      resumed?: boolean;
      demo?: boolean;
      fallback?: boolean;
    }
  // Phase P.4: on connect, the server advertises which agents this daemon can
  // run and which have credentials (`live`) — the onboarding picker's source.
  // No agent is assumed; `default` is only a hint for pre-selection.
  // Step 4.8 adds (optional/additive): `cwd` — the directory the daemon was
  // launched from, i.e. the default working dir for new sessions (terminal
  // parity) — and `home`, so the client can render paths in ~-form. Neither
  // is a secret: the daemon is local and the browser is the same user.
  // Step R.4 adds `relay` — the deliberately user-facing pairing info (HTTP
  // origin of the relay + the pairing code) so the shell can draw the
  // "connect a device" QR. Sent to LOCAL viewports only, over the loopback
  // socket the user already owns: the code must never travel the relay path,
  // even encrypted, so remote viewports get the hello without it.
  // Step R.4g adds `version` (optional/additive) — the daemon's package
  // version, for the status bar and bug reports.
  // Step R.4i adds `blocked` per agent entry (optional/additive): true means a
  // prohibited subscription credential is present (an Anthropic/Gemini login,
  // which their terms don't allow in a third-party app) — the picker shows the
  // API-key fix instead of a demo or a dead badge. Old clients ignore it and
  // see `live: false`. Step R.4k adds `detail` (optional/additive): a "what's
  // behind this row" label for a LIVE agent — its local endpoint or configured
  // model — so a local-model user sees their setup was picked up.
  | {
      type: "agents";
      agents: { agent: AgentName; live: boolean; blocked?: boolean; detail?: string }[];
      default: AgentName;
      cwd?: string;
      home?: string;
      relay?: { url: string; code: string };
      version?: string;
    }
  // Step R.4i: the daemon refused to attach this REMOTE (relay) viewport to the
  // session because the session's credential can't be used over the paid relay
  // — a subscription-backed agent (closed-model reselling posture). Sent instead
  // of session_created; the shell shows the reason. Never sent to local
  // viewports. `reason` is a stable machine tag; `message` is the human line.
  | { type: "refused"; reason: string; message: string }
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
  | { type: "thinking_delta"; text: string }
  // Step 4.9: the `!` bash passthrough, run in a real PTY (interactive
  // programs prompt normally). These three carry the command's lifecycle and
  // its OUTPUT stream — broadcast and replay-buffered like everything else;
  // what the user TYPES into the command travels only browser→server
  // (bang_input below) and never appears on this side of the wire. When a
  // program echoes typed input (echo on), that echo arrives here as ordinary
  // PTY output — exactly the terminal's behavior; password prompts turn echo
  // off, so a password never reaches the wire, the ring, or other viewports.
  | { type: "bang_start"; command: string; id: string }
  | { type: "bang_output"; data: string; id: string }
  // exitCode null = killed by signal (user stop, session close).
  | { type: "bang_end"; id: string; exitCode: number | null }
  // Step 4.4: reply to a client ping — connection liveness only, never
  // buffered or sequenced.
  | { type: "pong" }
  // Step 4.6: the fleet snapshot, sent to `watch_sessions` connections on
  // subscribe and re-sent whenever the fleet changes (create/close, status
  // transition, rename). Per-viewport plumbing — never buffered/sequenced.
  | { type: "sessions"; sessions: SessionMeta[] }
  // #11: the session was explicitly ended (from here, the fleet view, or another
  // tab). A per-viewport control signal — an attached viewport leaves to mission
  // control; never buffered or sequenced.
  | { type: "session_ended"; sessionId: string };

/** One fleet row (4.6). `lastActivity` is epoch ms of the last broadcast. */
export type SessionMeta = {
  sessionId: string;
  name: string;
  cwd: string;
  agent: AgentName;
  // #6: the model the session's agent is running (best-known label). Present
  // even before the first turn (from config/DEFAULT_MODEL); may refine after.
  model: string;
  status: "idle" | "working" | "permission";
  lastActivity: number;
  viewports: number;
};

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
  // starts a fresh one, optionally in a specific working dir. Step 4.4 adds
  // `afterSeq`: the last broadcast seq this viewport saw — when the server
  // still has everything after it in the ring buffer, it resumes with a
  // tail replay instead of a full repaint.
  // Step R.4g adds `clientVersion` to attach and create (optional/additive):
  // the browser bundle announces its build so a skewed daemon↔client pair is
  // visible in the daemon's log — the axis that matters once the relay puts
  // the phone bundle and the npm daemon on different release trains.
  | { type: "attach"; sessionId: string; afterSeq?: number; clientVersion?: string }
  // Phase P.4: `agent` names which terminal agent to run (chosen at onboarding);
  // omitted → the daemon's default. Credentials stay server-side, never sent.
  | { type: "create"; cwd?: string; agent?: AgentName; clientVersion?: string }
  // Phase 2: a component interaction, attributed to the render block
  // (sourceId = its render id) that emitted it.
  | { type: "action"; action: Action; sourceId: string }
  // Step 4.9: run `command` in a PTY in the session's cwd — the `!` path,
  // never routed through the model. `id` is client-minted so the issuing
  // viewport can correlate the broadcast stream and own the stdin affordance.
  | { type: "bang"; command: string; id: string }
  // EPHEMERAL SECRET PATH: a line typed into the running command's stdin
  // (possibly a password). Written to the PTY and nothing else — never
  // broadcast, never buffered, never logged, never re-serialized into a
  // WireMsg (per the secrets non-negotiable).
  | { type: "bang_input"; data: string; id: string }
  | { type: "bang_kill"; id: string }
  // Step 4.4: connection liveness probe; the server answers `pong`. Lets the
  // browser detect a half-open socket (wifi blip with no FIN) and reconnect.
  | { type: "ping" }
  // Step 4.6: this connection is a fleet watcher, not a session viewport —
  // it receives `sessions` snapshots instead of a transcript stream.
  | { type: "watch_sessions" }
  // Step 4.6: rename a session (fleet affordance; 4.2 deferred it here).
  | { type: "rename"; sessionId: string; name: string }
  // #11: explicitly end a session — kill its PTY, close the engine, drop it from
  // the fleet, and kick any attached viewports back to mission control. Usable
  // from a session viewport or a fleet watcher.
  | { type: "end_session"; sessionId: string };
