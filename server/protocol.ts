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
  // A SHELL-owned selector re-skinning interactive terminal chrome (/model,
  // /effort): arrow-key + click selection over the engine's own catalog, any
  // row count. Deliberately NOT a registry component — the registry is the
  // agent's surface and its constraints (e.g. question's option cap) are
  // discipline on generated UI, which must never bind a shell re-skin.
  // Choosing a row sends its `text` as the user's next turn over the same
  // mediated action path as a question click.
  | {
      type: "picker";
      id: string;
      title: string;
      rows: { label: string; detail?: string; current?: boolean; text: string }[];
      // The typed alternative (e.g. "Send `/model <id>` to switch"), shown dim.
      hint?: string;
    }
  // Phase T.1: the transcript record of a tool call. `tool_use` announces the
  // call (detail = its one human-salient argument, e.g. the bash command);
  // a later `tool_result` with the same id completes that record.
  // T2.2 widens it with the FULL input (optional — old clients ignore it);
  // the client renders Edit/Write inputs as diffs/code, the rest as JSON.
  // `parentId`, when set, is the Task tool_use id this call belongs to —
  // a subagent's call, which the client nests under its owning Task row (T2.4).
  | {
      type: "tool_use";
      name: string;
      detail?: string;
      id: string;
      input?: Record<string, unknown>;
      parentId?: string;
    }
  // `truncatedBytes`, when set, is how many UTF-8 bytes were elided
  // after the cap — the client shows an explicit marker rather than cutting
  // silently. Optional/additive. `parentId` rides here too, exactly as on
  // tool_use (T2.3, T2.4).
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
      // The engine's model label as known at attach time — the status bar
      // shows it from the first paint, not only after the first turn's usage
      // message. Absent while the engine hasn't resolved/reported one yet
      // (unconfigured sessions before the engine names its default): the bar
      // shows nothing rather than a stand-in (2026-07-23).
      model?: string;
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
  // Static-origin serving adds `ws` (optional/additive): the relay's ws(s)
  // origin, set when `url` is a SEPARATE static app origin (MIRAFOLD_APP_URL —
  // the relay serves no JS, the trust decision). The QR fragment carries it so
  // the loaded page knows where to dial; absent = the page dials its own host.
  // Step R.4g adds `version` (optional/additive) — the daemon's package
  // version, for the status bar and bug reports.
  // Step R.4i adds `blocked` per agent entry (optional/additive): true means a
  // prohibited subscription credential is present (an Anthropic/Gemini login,
  // which their terms don't allow in a third-party app) — the picker shows the
  // API-key fix instead of a demo or a dead badge. Old clients ignore it and
  // see `live: false`. Step R.4k adds `detail` (optional/additive): a "what's
  // behind this row" label for a LIVE agent — its local endpoint or configured
  // model — so a local-model user sees their setup was picked up.
  // Step N.3 adds `backends` per agent entry (optional/additive): EVERY way
  // that agent could run — each detected credential (no precedence collapse)
  // plus each running local model server the agent's API dialect can drive,
  // discovered by probe. The N.4 second-step picker's source; re-sent whole
  // on `refresh_agents` so a just-started local server appears live. Old
  // clients strip it and keep today's one-row-per-agent picker.
  | {
      type: "agents";
      agents: AgentInfo[];
      default: AgentName;
      cwd?: string;
      home?: string;
      relay?: { url: string; code: string; ws?: string };
      version?: string;
    }
  // The daemon refused to attach this REMOTE (relay) viewport to the
  // session because the session's credential can't be used over the paid relay
  // — a subscription-backed agent (closed-model reselling posture). Sent instead
  // of session_created; the shell shows the reason. Never sent to local
  // viewports. `reason` is a stable machine tag; `message` is the human line (R.4i).
  | { type: "refused"; reason: string; message: string }
  // Phase 3: agent-authored HTML for the sandboxed iframe host (the ONLY
  // channel raw agent markup may travel). Re-sending an id replaces that
  // artifact in place — same rule as `render`.
  | { type: "artifact"; html: string; id: string; title?: string }
  // Per-turn token/cost accounting for the shell's status bar. One
  // per completed turn (just before turn_end); the client sums for the
  // session total. Replay-safe — buffered like everything else (T2.6).
  | {
      type: "usage";
      // Absent when the engine hasn't reported its resolved model yet — the
      // status bar shows nothing rather than a stand-in (2026-07-23).
      model?: string;
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    }
  // Phase T2.1: the model's reasoning stream, full fidelity. Renders as a
  // dim block that folds to one line once the turn's real output starts —
  // collapse-on-finalize, never dropped.
  | { type: "thinking_delta"; text: string }
  // Phase F.2: a service-status line — an event the terminal shows and the
  // adapter would otherwise drop, so the UI never lies in degraded service:
  // an API retry (terminal shows "retrying…"; we'd sit on "thinking…" looking
  // hung), a context compaction (silent today), a rate-limit warning, a model
  // refusal (the turn appears to end for no reason). NOT an error — the turn
  // continues (retry/compaction) or ends honestly (refusal, alongside the
  // result). Drawn as a dim persistent system line, never agent markdown.
  // `kind` lets the client tag it; old clients ignore it and show the text.
  // 2026-07-20 adds `warning`: an engine's own non-fatal advisory, which the
  // terminal shows as a warning and we were escalating to a red `error` line —
  // louder than the agent we re-skin (Codex's ErrorItem, "a non-fatal error
  // surfaced as an item", e.g. no metadata for a local model's slug).
  // `source` names the ENGINE whose own words these are (2026-07-20 audit).
  // Absent means Mirafold is speaking: every other notice is shell-authored
  // prose, and the dim system line is a surface the user learns to trust as
  // ours. A verbatim engine string rendered there unattributed could pose as
  // Mirafold ("re-enter your API key at …") — so it carries the engine's name
  // and the client badges it. Adapters: pass it whenever the text is the
  // engine's, never when you composed the sentence yourself.
  | {
      type: "notice";
      text: string;
      kind?: "retry" | "compaction" | "rate_limit" | "refusal" | "warning";
      source?: string;
    }
  // The `!` bash passthrough, run in a real PTY (interactive
  // programs prompt normally). These three carry the command's lifecycle and
  // its OUTPUT stream — broadcast and replay-buffered like everything else;
  // what the user TYPES into the command travels only browser→server
  // (bang_input below) and never appears on this side of the wire. When a
  // program echoes typed input (echo on), that echo arrives here as ordinary
  // PTY output — exactly the terminal's behavior; password prompts turn echo
  // off, so a password never reaches the wire, the ring, or other viewports (4.9).
  | { type: "bang_start"; command: string; id: string }
  | { type: "bang_output"; data: string; id: string }
  // exitCode null = killed by signal (user stop, session close).
  | { type: "bang_end"; id: string; exitCode: number | null }
  // Phase E (Explorer): the shell's read-only file browser. Per-viewport
  // request/reply — like `pong`/`sessions`, never buffered or sequenced:
  // current disk state is a query, not session history, so it must not enter
  // the replay ring. `id` echoes the client's mint so racing replies
  // correlate. Entry paths are session-root-relative and /-separated (the
  // client nests them; the wire stays non-recursive, the file-tree rule).
  // Every request gets exactly one reply — an error rides the reply
  // (`error` set, other fields best-effort), never silence. `git` is false
  // until E.2's git layer lands (then: git's view of the tree + `status`
  // chars on entries). `truncated` marks a capped walk, honestly.
  | {
      type: "fs_tree";
      id: string;
      root: string;
      entries: FsEntry[];
      git: boolean;
      truncated?: boolean;
      error?: string;
    }
  // One file's content (the fs_read reply). `binary` = NUL-sniffed, content
  // withheld. `truncatedBytes` mirrors tool_result's honest cap: how many
  // bytes of the real file were elided after the content cap.
  | {
      type: "fs_file";
      id: string;
      path: string;
      content?: string;
      size?: number;
      truncatedBytes?: number;
      binary?: boolean;
      error?: string;
    }
  // The fs_diff reply (E.2): one file's change as BEFORE/AFTER text — never
  // hunk/patch text (the render_diff lesson: snippets need no bookkeeping;
  // the client diffs them with the same differ ToolBlock uses). `before` is
  // HEAD's version (absent in HEAD / unborn HEAD → ""), `after` the working
  // tree (deleted → ""). Sides are capped independently and honestly;
  // `binary` on either side withholds both texts. Same per-viewport rules as
  // fs_tree/fs_file.
  | {
      type: "fs_file_diff";
      id: string;
      path: string;
      before?: string;
      after?: string;
      beforeTruncatedBytes?: number;
      afterTruncatedBytes?: number;
      binary?: boolean;
      error?: string;
    }
  // Reply to a client ping — connection liveness only, never
  // buffered or sequenced (4.4).
  | { type: "pong" }
  // The fleet snapshot, sent to `watch_sessions` connections on
  // subscribe and re-sent whenever the fleet changes (create/close, status
  // transition, rename). Per-viewport plumbing — never buffered/sequenced (4.6).
  | { type: "sessions"; sessions: SessionMeta[] }
  // The session was explicitly ended (from here, the fleet view, or another
  // tab). A per-viewport control signal — an attached viewport leaves to mission
  // control; never buffered or sequenced (#11).
  | { type: "session_ended"; sessionId: string };

/** One agent's row in the `agents` hello — what the onboarding picker renders
 *  (P.4 tri-state via `live`/`blocked`, R.4k `detail`, N.3 `backends`).
 *  `kind` is the backing a one-click create would use — set only when `live`,
 *  so the row can NAME what it's about to run on (2026-07-20). A single usable
 *  backend skips the second step, which is where that name used to appear;
 *  skipping the menu must not mean skipping the disclosure. */
export type AgentInfo = {
  agent: AgentName;
  live: boolean;
  blocked?: boolean;
  kind?: "api-key" | "subscription" | "local";
  detail?: string;
  backends?: AgentBackend[];
};

/**
 * One way an agent could run (N.3) — a row in the second-step picker. A
 * detected credential (`api-key` / `subscription`) or a local endpoint:
 * env-configured, or a probe-discovered running server (then `endpoint` /
 * `runtime` / `models` are set — pick a model to pick the backend). `usable`
 * is provider-policy's verdict; `blocked` marks a present-but-prohibited
 * subscription, listed visible-but-gray, never hidden. Never carries a
 * secret — kinds and labels only.
 */
export type AgentBackend = {
  kind: "api-key" | "subscription" | "local";
  usable: boolean;
  blocked?: boolean;
  detail?: string;
  endpoint?: string;
  runtime?: string;
  models?: string[];
  // The single model this row will run, when config/env determines it — the
  // env override for a credential row, the config's own `model` for a declared
  // provider row. Display only (the pick sends no model; the agent resolves it
  // exactly as it would in a terminal). Absent when only the engine's own
  // default applies, which we don't know without asking it. A row with a
  // `models` catalog has no single answer — you pick one.
  model?: string;
  // A provider the user declared in their agent's own config (codex's
  // `[model_providers.<id>]`) — its id, so a pick can name it exactly.
  provider?: string;
  // Why an unusable row is unusable, when the generic per-agent hint would be
  // wrong (e.g. a declared provider whose env_key variable isn't set).
  hint?: string;
};

/** The onboarding picker's backend choice (N.4), riding `create`. `endpoint`
 *  names a discovered local server (absent = the env-configured one for kind
 *  `local`); `provider` names a config-declared provider row; `model` is the
 *  picked catalog entry. Labels only — never a secret. */
export type BackendChoice = {
  kind: "api-key" | "subscription" | "local";
  endpoint?: string;
  provider?: string;
  model?: string;
};

/** One Explorer tree entry (Phase E.1): a FILE, by root-relative /-separated
 *  path — directories are inferred client-side (git's `ls-files` view has no
 *  directory rows either, so repo and non-repo trees stay one shape; the
 *  known cost is that empty directories are invisible). `status` arrives with
 *  E.2's git layer: a single collapsed change char (M/A/D/U). */
export type FsEntry = { path: string; status?: string };

/** One fleet row (4.6). `lastActivity` is epoch ms of the last broadcast. */
export type SessionMeta = {
  sessionId: string;
  name: string;
  cwd: string;
  agent: AgentName;
  // The model the session's agent is running (best-known label); may refine
  // after the first turn (#6). Absent when not yet known — the fleet row
  // shows nothing rather than a stand-in (2026-07-23).
  model?: string;
  status: "idle" | "working" | "permission";
  lastActivity: number;
  viewports: number;
  // Phase M cockpit state (all optional/additive — old clients strip them,
  // R.4h). Derived by the registry from the broadcast stream itself, so every
  // agent carries them with no adapter cooperation (M.1).
  // When the session was created — the cockpit's stable sort key (M.3).
  createdAt?: number;
  // What the session is doing RIGHT NOW ("thinking", a tool name, "! <cmd>");
  // `since` is when that label started, so the client ticks elapsed time
  // locally. Absent when idle. Engine-derived text — the fleet renders it as
  // inert plain text only, never markdown (the trusted-shell rule).
  activity?: { label: string; since: number };
  // The pending-permission queue, oldest first — what the session is blocked
  // on. Lives exactly as long as the 4.6 status hold: cleared when the stream
  // moves off "permission". Same inert-text trust rule as `activity`.
  permissions?: { id: string; tool: string; detail: string }[];
  // Session-total usage, folded under the status bar's exact rule (T2.6):
  // per-turn tokens SUMMED; costUsd TAKEN (it arrives session-cumulative),
  // never summed.
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
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
  // N.4 adds `backend` (optional/additive): the second-step picker's choice —
  // which of the advertised backends to run on. Omitted → the daemon's
  // credential-precedence default (every pre-N client). The server treats it
  // as a REQUEST: N.5 re-validates against detection + provider-policy and
  // refuses a forged/prohibited choice — the client is never trusted.
  | {
      type: "create";
      cwd?: string;
      agent?: AgentName;
      clientVersion?: string;
      backend?: BackendChoice;
    }
  // Phase 2: a component interaction, attributed to the render block
  // (sourceId = its render id) that emitted it.
  | { type: "action"; action: Action; sourceId: string }
  // Run `command` in a PTY in the session's cwd — the `!` path,
  // never routed through the model. `id` is client-minted so the issuing
  // viewport can correlate the broadcast stream and own the stdin affordance (4.9).
  | { type: "bang"; command: string; id: string }
  // EPHEMERAL SECRET PATH: a line typed into the running command's stdin
  // (possibly a password). Written to the PTY and nothing else — never
  // broadcast, never buffered, never logged, never re-serialized into a
  // WireMsg (per the secrets non-negotiable).
  | { type: "bang_input"; data: string; id: string }
  | { type: "bang_kill"; id: string }
  // Connection liveness probe; the server answers `pong`. Lets the
  // browser detect a half-open socket (wifi blip with no FIN) and reconnect (4.4).
  | { type: "ping" }
  // This connection is a fleet watcher, not a session viewport —
  // it receives `sessions` snapshots instead of a transcript stream (4.6).
  | { type: "watch_sessions" }
  // Rename a session (fleet affordance; 4.2 deferred it here) (4.6).
  | { type: "rename"; sessionId: string; name: string }
  // Explicitly end a session — kill its PTY, close the engine, drop it from
  // the fleet, and kick any attached viewports back to mission control. Usable
  // from a session viewport or a fleet watcher (#11).
  | { type: "end_session"; sessionId: string }
  // Phase M cockpit acts (M.2) — sessionId-addressed like end_session, so a
  // fleet watcher can act on a session without attaching. Acting from the
  // grid grants nothing a local viewport couldn't do by attaching; the two
  // acts that DRIVE the model (answer_permission's allow path,
  // prompt_session) are refused on a REMOTE (relay) connection when the
  // session's credential can't ride the paid relay — the R.4i gate, same
  // rule as attach. interrupt_session stays ungated, like end_session
  // (teardown, not model use). Unknown session ids answer with an `error`.
  | { type: "answer_permission"; sessionId: string; id: string; allow: boolean }
  | { type: "interrupt_session"; sessionId: string }
  | { type: "prompt_session"; sessionId: string; text: string }
  // Re-probe local model servers and re-send the `agents` hello (N.3). The
  // onboarding picker sends this on a slow interval while open, so the
  // "start your local server and it appears here" promise is live — no
  // reload. Server-side throttled; a burst degrades to the cached answer.
  | { type: "refresh_agents" }
  // Phase E (Explorer): the read-only file browser's per-viewport queries.
  // `id` is client-minted (the bang-id grammar) so the issuing component can
  // correlate the one reply each request gets. The path is a REQUEST — the
  // server jails every resolution to the session root and refuses secret env
  // files; the client is never trusted with a path. Both types are throttled
  // per connection (throttled requests still get an error reply).
  | { type: "fs_list"; id: string }
  | { type: "fs_read"; id: string; path: string }
  // E.2: "what changed in this file" — answered as fs_file_diff. Same id
  // grammar, same jail, same throttle family as fs_read.
  | { type: "fs_diff"; id: string; path: string }
  // The browser half's uncaught errors (window "error"/"unhandledrejection"),
  // forwarded so the daemon's flight-recorder log hears about a front-end
  // crash — otherwise a "it went blank" bug report arrives with an empty log
  // (R.4g follow-through, 2026-07-23). Client-clipped and capped per page;
  // the server re-caps per connection and treats the text as untrusted:
  // logged only, never broadcast, never echoed back into any surface.
  | { type: "client_error"; message: string; clientVersion?: string };
