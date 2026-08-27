// Wire protocol — the contract between server and browser.
// Later phases ADD message types; existing shapes never change.
// The web side imports these same types via the `@protocol` alias.
//
// The flip side of additive-only, stated as a RULE (tested in ws.test.ts and
// session.itest.ts): both ends IGNORE unknown message types — no error, no
// close. That's what lets an old client face a new daemon (and vice versa
// once the relay puts them on different release trains). The client must
// still honor `seq` on unknown broadcast types, or resume would re-replay
// frames it already saw. Same spirit one layer up: the client validates
// render props with the tolerant clientSchemas (unknown keys strip) and
// shows unknown agent names as raw strings.

/**
 * The terminal agents Mirafold can re-skin (one adapter each). The browser
 * picks which agent a session runs in the agent picker, so the name is part of the
 * shared contract (adapters/types.ts re-exports it).
 */
export type AgentName = "claude-code" | "codex" | "gemini-cli" | "opencode";

/** One provider-owned completion shown by the trusted prompt shell before a
 * prompt is submitted. `value` includes its trigger (`/model`, `$audit`), so
 * insertion is mechanical and never reconstructed by the browser. */
export type PromptOption = {
  trigger: "/" | "$";
  value: string;
  label: string;
  description?: string;
  argumentHint?: string;
  kind: "command" | "skill";
  aliases?: string[];
  // Fixed by the adapter/daemon, never copied from provider metadata. When
  // provider- or checkout-supplied text is present, the trusted prompt shell
  // turns this enum into a visible attribution badge so that text cannot pose
  // as Mirafold's own instruction. Optional for older daemons/checkpoints.
  source?: AgentName | "mirafold";
};

/**
 * Server → browser.
 * Every message BROADCAST onto a session's stream also carries
 * `seq?: number` (optional/additive) — a session-scoped, strictly increasing
 * sequence number stamped by the registry (see the intersection on the union
 * below). A reconnecting viewport sends the last seq it saw
 * (`attach.afterSeq`) and the server replays only the tail — resume without
 * a repaint. Per-viewport messages (session_created, agents, pong) carry no
 * seq: they're connection plumbing, not session history.
 *
 * A message REPLAYED from the buffer on attach also carries `replay: true`
 * (optional/additive), stamped at replay time (never stored). History and
 * live traffic paint identically, but side effects that only make sense for
 * a live event — the screen-reader announcements, above all — must not
 * re-fire for every historical turn on each page load/reconnect. Old clients
 * ignore the field.
 */
export type WireMsg = WireMsgBody & { seq?: number; replay?: true };
/** The session-stream subset: what an adapter emits and the registry
 *  broadcasts. Only these take a sequence number, replay on attach, and
 *  persist in a checkpoint. */
export type SessionMsg = SessionMsgBody & { seq?: number; replay?: true };

type WireMsgBody = SessionMsgBody | ViewportMsgBody;

/** Session history — one session's stream, delivered to every attached
 *  viewport in order. `prompt_options` rides here as the one replaceable
 *  member: it is broadcast but never sequenced or kept in the transcript. */
export type SessionMsgBody =
  // `parentId` (optional/additive, like tool_use's): when set, this prose is
  // a SUBAGENT's, grouped under the spawn record whose wire id it names. The
  // handle is OPAQUE and adapter-chosen — shared code only ever groups by
  // it, never parses or dereferences it (for Claude Code it happens to be
  // the spawn tool_use id; the protocol does not promise that). Old clients
  // ignore the field and render the prose inline.
  | { type: "text_delta"; text: string; parentId?: string }
  // The selected provider's live prompt-completion catalog. This is shell
  // data, not agent-authored UI: the browser opens it as soon as the trigger
  // is typed, before anything is sent to the provider. A new message
  // replaces the prior catalog whole (Claude commands may change as the
  // working directory changes).
  | { type: "prompt_options"; options: PromptOption[] }
  | { type: "status"; state: "thinking" | "tool"; label?: string }
  | { type: "turn_end" }
  // Adapter failures end a model turn by default. Request-scoped shell
  // failures opt out explicitly so they can render without closing an
  // unrelated turn or clearing its permission state.
  | { type: "error"; message: string; terminal?: false }
  // "Show component X with props P." `component` is a plain string on the
  // wire (not keyof the registry spec) so an unknown/malformed instruction is
  // still representable and can degrade gracefully client-side. Re-sending
  // an already-seen `id` updates that component's props in place — the
  // mechanism that keeps pinned paintings live.
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
  // The transcript record of a tool call. `tool_use` announces the call
  // (detail = its one human-salient argument, e.g. the bash command); a
  // later `tool_result` with the same id completes that record. `input` is
  // the FULL input (optional — old clients ignore it); the client renders
  // Edit/Write inputs as diffs/code, the rest as JSON. `parentId`, when set,
  // is the Task tool_use id this call belongs to — a subagent's call, which
  // the client nests under its owning Task row.
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
  // tool_use.
  | {
      type: "tool_result";
      output: string;
      isError?: boolean;
      id: string;
      truncatedBytes?: number;
      parentId?: string;
    }
  // The turn is paused on a gated tool call until the browser answers (or
  // the server times out to deny). Drawn by the trusted shell. `parentId`
  // (optional/additive): set when the ASKER is a subagent — the same opaque
  // spawn handle the tool/prose lanes group by. The shell shows a dim
  // "subagent" chip; the ask itself is answered exactly like any other. Old
  // clients ignore the field.
  | { type: "permission_request"; tool: string; detail: string; id: string; parentId?: string }
  // The ask above RESOLVED — answered from ANY viewport, or auto-denied by
  // the adapter's timeout/interrupt. Broadcast on the session stream so
  // every attached viewport (and the replay buffer) drops the bar the moment
  // it can no longer be answered; otherwise a second viewport keeps showing
  // the ask until turn_end and a tap on it is a silent stale no-op at the
  // adapter. Adapters that emit permission_request MUST emit this for every
  // resolution path.
  | { type: "permission_resolved"; id: string; allow: boolean }
  // The server's echo of a user turn. User strips come off the wire (not a
  // local echo) so every attached viewport — and the replay buffer — carries
  // them identically.
  | { type: "user_prompt"; text: string }
  // Agent-authored HTML for the sandboxed iframe host (the ONLY channel raw
  // agent markup may travel). Re-sending an id replaces that artifact in
  // place — same rule as `render`.
  | { type: "artifact"; html: string; id: string; title?: string }
  // Per-turn token/cost accounting for the shell's status bar. One
  // per completed turn (just before turn_end); the client sums for the
  // session total. Replay-safe — buffered like everything else.
  | {
      type: "usage";
      // Absent when the engine hasn't reported its resolved model yet — the
      // status bar shows nothing rather than a stand-in.
      model?: string;
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    }
  // The model's reasoning stream, full fidelity. Renders as a dim block that
  // folds to one line once the turn's real output starts —
  // collapse-on-finalize, never dropped. `parentId` rides here too, exactly
  // as on text_delta: a subagent's reasoning, grouped under its deck.
  | { type: "thinking_delta"; text: string; parentId?: string }
  // A service-status line — an event the terminal shows and the adapter
  // would otherwise drop, so the UI never lies in degraded service: an API
  // retry (terminal shows "retrying…"; we'd sit on "thinking…" looking
  // hung), a context compaction, a rate-limit warning, a model refusal (the
  // turn appears to end for no reason). NOT an error — the turn continues
  // (retry/compaction) or ends honestly (refusal, alongside the result).
  // Drawn as a dim persistent system line, never agent markdown. `kind` lets
  // the client tag it; old clients ignore it and show the text. `warning` is
  // an engine's own non-fatal advisory, which the terminal shows as a
  // warning — escalating it to a red `error` line would be louder than the
  // agent we re-skin (Codex's ErrorItem, "a non-fatal error surfaced as an
  // item", e.g. no metadata for a local model's slug).
  // `source` names the ENGINE whose own words these are. Absent means
  // Mirafold is speaking: every other notice is shell-authored prose, and
  // the dim system line is a surface the user learns to trust as ours. A
  // verbatim engine string rendered there unattributed could pose as
  // Mirafold ("re-enter your API key at …") — so it carries the engine's
  // name and the client badges it. Adapters: pass it whenever the text is
  // the engine's, never when you composed the sentence yourself.
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
  // off, so a password never reaches the wire, the ring, or other viewports.
  // `silent` marks a `!!` command: shell only — its transcript never reaches
  // the agent, so viewports draw the `!!` glyph (replay included).
  | { type: "bang_start"; command: string; id: string; silent?: true }
  | { type: "bang_output"; data: string; id: string }
  // exitCode null = killed by signal (user stop, session close).
  | { type: "bang_end"; id: string; exitCode: number | null };

/** Per-viewport plumbing: answers to one connection's own requests, fleet
 *  and agent metadata, lifecycle notices. Never sequenced, replayed, or
 *  persisted — a session_ended or fs_* reply is not history. */
export type ViewportMsgBody =
  // Reply to attach/create — which session this viewport is on. `agent`
  // (optional/additive): which terminal agent is behind the session, so the
  // status bar can name it. `resumed`: true means the server honored
  // `attach.afterSeq` and will replay only the tail — the client keeps its
  // state and must NOT reset the zone; absent/false means a full replay
  // follows. `demo` (optional/additive): true means the agent had no
  // credentials and this session runs the scripted mock — the shell draws a
  // persistent demo banner the agent can't fake or clear (same trust rule as
  // the permission bar). `fallback` (optional/additive): true means the
  // viewport asked to attach to a session this registry and its durable
  // store don't have (explicitly ended, removed, or created before durable
  // recovery) and got a FRESH one instead — the shell must say so, never
  // silently swap the URL over a blank transcript.
  | {
      type: "session_created";
      sessionId: string;
      cwd: string;
      agent?: AgentName;
      // The engine's model label as known at attach time — the status bar
      // shows it from the first paint, not only after the first turn's usage
      // message. Absent while the engine hasn't resolved/reported one yet
      // (unconfigured sessions before the engine names its default): the bar
      // shows nothing rather than a stand-in.
      model?: string;
      resumed?: boolean;
      demo?: boolean;
      fallback?: boolean;
    }
  // On connect, the server advertises which agents this daemon can run and
  // which have credentials (`live`) — the agent picker's source. No
  // agent is assumed; `default` is only a hint for pre-selection.
  // `cwd` (optional/additive) — the directory the daemon was launched from,
  // i.e. the default working dir for new sessions (terminal parity) — and
  // `home`, so the client can render paths in ~-form. Neither is a secret:
  // the daemon is local and the browser is the same user.
  // `relay` — the deliberately user-facing pairing info (HTTP origin of the
  // relay + the pairing code) so the shell can draw the "connect a device"
  // QR. Sent to LOCAL viewports only, over the loopback socket the user
  // already owns: the code must never travel the relay path, even encrypted,
  // so remote viewports get the hello without it.
  // `ws` (optional/additive): the relay's ws(s) origin, set when `url` is a
  // SEPARATE static app origin (MIRAFOLD_APP_URL — the relay serves no JS,
  // the trust decision). The QR fragment carries it so the loaded page knows
  // where to dial; absent = the page dials its own host.
  // `version` (optional/additive) — the daemon's package version, for the
  // status bar and bug reports.
  // `blocked` per agent entry (optional/additive): true means a prohibited
  // subscription credential is present (an Anthropic/Gemini login, which
  // their terms don't allow in a third-party app) — the picker shows the
  // API-key fix instead of a demo or a dead badge. Old clients ignore it and
  // see `live: false`. `detail` (optional/additive): a "what's behind this
  // row" label for a LIVE agent — its local endpoint or configured model —
  // so a local-model user sees their setup was picked up.
  // `backends` per agent entry (optional/additive): EVERY way that agent
  // could run — each detected credential (no precedence collapse) plus each
  // running local model server the agent's API dialect can drive, discovered
  // by probe. The second-step picker's source; re-sent whole on
  // `refresh_agents` so a just-started local server appears live. Old
  // clients strip it and keep the one-row-per-agent picker.
  | {
      type: "agents";
      agents: AgentInfo[];
      default: AgentName;
      cwd?: string;
      home?: string;
      // This viewport can ask the daemon to open a native folder dialog on
      // the host. False/absent keeps the manual path field only (old daemon,
      // relay viewport, or Linux without Zenity/KDialog).
      folderPicker?: boolean;
      relay?: { url: string; code: string; ws?: string };
      // Optional/additive: WHY remote access is off, when it is — the pair
      // button's honest state when there is no `relay` to draw a QR for.
      // `unentitled` = nothing configured (the button offers Mirafold Pro);
      // `opt-out` = MIRAFOLD_RELAY_URL=off; `malformed-url` = the explicit
      // relay URL was refused at boot. LOCAL viewports only — a remote
      // viewport is proof the relay is on; it gets neither field. Old
      // clients strip it and keep no button.
      relayOff?: "unentitled" | "opt-out" | "malformed-url";
      version?: string;
      // Optional/additive: this daemon runs on a license key and can manage
      // the subscription behind it — the "manage subscription" affordance's
      // gate. LOCAL viewports only (billing actions stay on the machine that
      // holds the key); token-override, self-host, and unentitled daemons
      // send nothing. Old clients strip it.
      billing?: "license-key";
      // Optional/additive: the daemon's current license-key read, riding
      // the hello itself so a client never holds one from a PREVIOUS
      // daemon (a relaunch on the same port re-hellos without one when it
      // no longer presents on the exchange). Changes after the hello ride
      // the `entitlement` message below. LOCAL viewports only.
      entitlement?: EntitlementView;
    }
  // One local, per-viewport reply to `pick_folder`; never broadcast or
  // replayed. Cancel is explicit so an empty reply cannot strand the button.
  | { type: "folder_picked"; id: string; path?: string; canceled?: true; error?: string }
  // The one reply to all three subscription_* requests — the
  // manage-subscription card's data, per-viewport request/reply (echoed
  // client-minted id), never broadcast or replay-buffered. Success carries
  // the view (`cancelAt` set = a cancellation is scheduled for that
  // instant); failure carries `error` and nothing else. The license key
  // itself never rides this wire in either direction — the daemon holds it.
  | {
      type: "subscription";
      id: string;
      status?: string;
      periodEnd?: string;
      cancelAt?: string;
      error?: string;
    }
  // The daemon's read on its own license key — LICENSE-KEY MODE ONLY, local
  // viewports only, sent right after every hello and again whenever it
  // changes (the boot exchange landing, a 12-hourly refresh, a lapse). The
  // pair card presents on it: `valid` = the QR; `invalid` = the key was
  // refused (`reason` is the billing backend's line, capped) — no QR, the
  // offer instead; `unreachable` = the backend couldn't be asked — `cached`
  // says whether an unexpired token still carries the relay meanwhile;
  // `checking` = the first exchange hasn't answered yet. Never a claim of
  // validity the backend didn't make. Old clients strip it.
  | {
      type: "entitlement";
      state: "checking" | "valid" | "invalid" | "unreachable";
      reason?: string;
      cached?: boolean;
    }
  // The daemon refused to attach this REMOTE (relay) viewport to the
  // session because the session's credential can't be used over the paid relay
  // — a subscription-backed agent (closed-model reselling posture). Sent instead
  // of session_created; the shell shows the reason. Never sent to local
  // viewports. `reason` is a stable machine tag; `message` is the human line.
  | { type: "refused"; reason: string; message: string }
  // The shell's read-only file browser. Per-viewport request/reply — like
  // `pong`/`sessions`, never buffered or sequenced: current disk state is a
  // query, not session history, so it must not enter the replay ring. `id`
  // echoes the client's mint so racing replies correlate. Entry paths are
  // session-root-relative and /-separated (the client nests them; the wire
  // stays non-recursive, the file-tree rule). Every request gets exactly one
  // reply — an error rides the reply (`error` set, other fields
  // best-effort), never silence. `git` true means git's view of the tree,
  // with `status` chars on entries. `truncated` marks a capped walk,
  // honestly.
  | {
      type: "fs_tree";
      id: string;
      root: string;
      entries: FsEntry[];
      git: boolean;
      truncated?: boolean;
      error?: string;
    }
  // One directory's children (the fs_listdir reply) — the lazy tree's fetch
  // unit. Same per-viewport rules as fs_tree: request/reply, never buffered
  // or sequenced; every request gets exactly one reply, an error rides the
  // reply. `path` echoes the request so racing replies correlate beyond the
  // id. Entries are NAMES (not paths — the client owns nesting), capped per
  // directory with `truncated` honest. `status` chars come from the
  // multi-repo git layer.
  | {
      type: "fs_dir";
      id: string;
      path: string;
      entries: FsDirEntry[];
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
  // The fs_diff reply: one file's change as BEFORE/AFTER text — never
  // hunk/patch text (snippets need no bookkeeping; the client diffs them
  // with the same differ ToolBlock uses). `before` is
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
      // Opaque keyed identity of the exact HEAD + working-tree bytes.
      // Absent when the bounded reader cannot establish an exact revision.
      revision?: string;
      error?: string;
    }
  // The complete Git change set for the session workspace.
  // `root` is each repository's session-root-relative directory ("" when
  // the session itself is in one repo); entry paths are session-root-relative
  // so they can ride the existing fs_read/fs_diff jail unchanged. A parent
  // directory holding several repos gets one explicit group per repo. Like
  // every fs_* query this is per-viewport, correlated, never replayed, and
  // cap/error honest.
  | {
      type: "fs_change_set";
      id: string;
      repos: FsChangeRepo[];
      truncated?: boolean;
      error?: string;
    }
  // The live-tree doorbell: something under the session root changed on
  // disk. Pushed to every ATTACHED viewport — per-viewport plumbing like
  // the fs_* replies, never buffered or sequenced (a bell about past disk
  // state is useless on reattach; the panel refetches on open regardless).
  // `paths` is a best-effort root-relative hint, capped at the source with
  // `truncated` honest — and a truncated or absent hint still means exactly
  // what an empty bell means: something changed, refetch what you show.
  // Consumers must never require the hint; this is a doorbell, not a
  // per-file event feed (the no-extensions decision is what makes that
  // sufficient permanently).
  | {
      type: "fs_changed";
      paths?: string[];
      truncated?: boolean;
      // A bounded fs_listdir reply shipped before Git status was ready. The
      // settled cache should refresh visible badges, but no disk mutation is
      // being reported and review progress must not be invalidated. Optional
      // so older clients still perform their existing safe refresh.
      reason?: "status";
    }
  // File drag-and-drop input: the staged-upload replies. A drop
  // ships the file's BYTES (browsers never expose a dropped file's real
  // path) in bounded chunks; `done` answers with the absolute path the
  // daemon staged them at — OUTSIDE the working tree — which the shell
  // inserts into the prompt for the agent to read with its own tools,
  // exactly like a terminal drop's inserted path. Correlated per-viewport
  // request/reply (echoed client-minted id) — never broadcast, never
  // replay-buffered. `name` rides `done` so the strip can label the result
  // without holding client state hostage to it.
  | { type: "file_upload_done"; id: string; path: string; name: string }
  | { type: "file_upload_error"; id: string; message: string }
  // Reply to a client ping — connection liveness only, never
  // buffered or sequenced.
  | { type: "pong" }
  // The fleet snapshot, sent to `watch_sessions` connections on
  // subscribe and re-sent whenever the fleet changes (create/close, status
  // transition, rename). Per-viewport plumbing — never buffered/sequenced.
  | { type: "sessions"; sessions: SessionMeta[] }
  // The session was explicitly ended (from here, the fleet view, or another
  // tab). A per-viewport control signal — an attached viewport leaves to mission
  // control; never buffered or sequenced.
  | { type: "session_ended"; sessionId: string };

/** One agent's row in the `agents` hello — what the agent picker renders
 *  (tri-state via `live`/`blocked`, plus `detail` and `backends`).
 *  `kind` is the backing a one-click create would use — set only when `live`,
 *  so the row can NAME what it's about to run on. A single usable backend
 *  skips the second step, which is where that name would otherwise appear;
 *  skipping the menu must not mean skipping the disclosure. */
export type AgentInfo = {
  agent: AgentName;
  live: boolean;
  blocked?: boolean;
  // "gateway" (OpenCode Zen) is additive: an older bundle shows its generic
  // fallback label for an unknown kind, nothing breaks.
  kind?: "api-key" | "subscription" | "local" | "gateway";
  detail?: string;
  backends?: AgentBackend[];
};

/**
 * One way an agent could run — a row in the second-step picker. A
 * detected credential (`api-key` / `subscription`) or a local endpoint:
 * env-configured, or a probe-discovered running server (`runtime` / `models`
 * are then set — pick a model to pick the backend). A probe-discovered server
 * carries `endpoint`; a configured Claude endpoint carries only an opaque
 * daemon-scoped `backendId`, while a Codex config row carries its provider id
 * but never its base URL. Configured URLs can contain credentials, private
 * hosts, or signed queries. `usable` is provider-policy's verdict; `blocked` marks a
 * present-but-prohibited subscription, listed visible-but-gray, never hidden.
 * `onDevice` is derived by the daemon from exact IP loopback classification;
 * the browser never infers this privacy claim from a hostname prefix.
 */
export type AgentBackend = {
  kind: "api-key" | "subscription" | "local" | "gateway";
  usable: boolean;
  blocked?: boolean;
  detail?: string;
  endpoint?: string;
  backendId?: string;
  onDevice?: true;
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

/** The agent picker's backend choice, riding `create`. `endpoint`
 *  names a probe-discovered local server; `backendId` names a configured
 *  endpoint opaquely; `provider` names a config-declared provider row; `model`
 *  is the picked catalog entry. Labels and opaque identifiers only — never a
 *  configured URL or credential. */
export type BackendChoice = {
  kind: "api-key" | "subscription" | "local" | "gateway";
  endpoint?: string;
  backendId?: string;
  provider?: string;
  model?: string;
};

/** One folder tree tree entry: a FILE, by root-relative /-separated path —
 *  directories are inferred client-side (git's `ls-files` view has no
 *  directory rows either, so repo and non-repo trees stay one shape; the
 *  known cost is that empty directories are invisible). `status` is the git
 *  layer's single collapsed change char (M/A/D/U). */
export type FsEntry = { path: string; status?: string };

/** One repository in the workspace change set. Both `root` and every
 *  entry path are relative to the immutable session root and /-separated. */
export type FsChangeRepo = {
  root: string;
  entries: FsEntry[];
  truncated?: boolean;
  error?: string;
};

/** One child in an fs_dir reply: a NAME within the listed directory —
 *  never a path; the client owns nesting (the lazy-tree inversion of
 *  FsEntry's flat file paths). `kind` comes from lstat semantics, so a
 *  symlink-to-dir is a `symlink` — the leaf rule: links are never expandable,
 *  a link can't graft an outside (or cyclic) tree into the panel. `status`
 *  is the per-repo git char (M/A/D/U). */
export type FsDirEntry = { name: string; kind: "dir" | "file" | "symlink"; status?: string };

/** One fleet row. `lastActivity` is epoch ms of the last broadcast. */
export type SessionMeta = {
  sessionId: string;
  name: string;
  cwd: string;
  agent: AgentName;
  // The model the session's agent is running (best-known label); may refine
  // after the first turn. Absent when not yet known — the fleet row shows
  // nothing rather than a stand-in.
  model?: string;
  status: "idle" | "working" | "permission";
  lastActivity: number;
  viewports: number;
  // Cockpit state (all optional/additive — old clients strip them). Derived
  // by the registry from the broadcast stream itself, so every agent carries
  // them with no adapter cooperation.
  // When the session was created — the cockpit's stable sort key.
  createdAt?: number;
  // What the session is doing RIGHT NOW ("thinking", a tool name, "! <cmd>");
  // `since` is when that label started, so the client ticks elapsed time
  // locally. Absent when idle. Engine-derived text — the fleet renders it as
  // inert plain text only, never markdown (the trusted-shell rule).
  activity?: { label: string; since: number };
  // The pending-permission queue, oldest first — what the session is blocked
  // on. Lives exactly as long as the status hold: cleared when the stream
  // moves off "permission". Same inert-text trust rule as `activity`.
  permissions?: { id: string; tool: string; detail: string }[];
  // Session-total usage, folded under the status bar's exact rule:
  // per-turn tokens SUMMED; costUsd TAKEN (it arrives session-cumulative),
  // never summed.
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
};

/**
 * The complete vocabulary of what a component interaction may do.
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
  // Halt the in-flight turn (the session stays warm).
  | { type: "interrupt" }
  // The user's answer to a permission_request.
  | { type: "permission_response"; id: string; allow: boolean }
  // A connection is a viewport onto a registry session. attach joins an
  // existing session (stale ids fall back to create); create starts a fresh
  // one, optionally in a specific working dir. `afterSeq`: the last
  // broadcast seq this viewport saw — when the server still has everything
  // after it in the ring buffer, it resumes with a tail replay instead of a
  // full repaint.
  // `clientVersion` on attach and create (optional/additive): the browser
  // bundle announces its build so a skewed daemon↔client pair is visible in
  // the daemon's log — the axis that matters once the relay puts the phone
  // bundle and the npm daemon on different release trains.
  | { type: "attach"; sessionId: string; afterSeq?: number; clientVersion?: string }
  // `agent` names which terminal agent to run (chosen in the agent picker);
  // omitted → the daemon's default. Credentials stay server-side, never sent.
  // `backend` (optional/additive): the second-step picker's choice — which
  // of the advertised backends to run on. Omitted → the daemon's
  // credential-precedence default (old clients). The server treats it as a
  // REQUEST: it re-validates against detection + provider-policy and
  // refuses a forged/prohibited choice — the client is never trusted.
  | {
      type: "create";
      cwd?: string;
      agent?: AgentName;
      clientVersion?: string;
      backend?: BackendChoice;
    }
  // A component interaction, attributed to the render block
  // (sourceId = its render id) that emitted it.
  | { type: "action"; action: Action; sourceId: string }
  // Run `command` in a PTY in the session's cwd — the `!` path,
  // never routed through the model. `id` is client-minted so the issuing
  // viewport can correlate the broadcast stream and own the stdin affordance.
  // `silent` (the `!!` form): run it, show it, and never hand the transcript
  // to the agent — not as a turn, not as later context.
  | { type: "bang"; command: string; id: string; silent?: true }
  // EPHEMERAL SECRET PATH: a line typed into the running command's stdin
  // (possibly a password). Written to the PTY and nothing else — never
  // broadcast, never buffered, never logged, never re-serialized into a
  // WireMsg (per the secrets non-negotiable).
  | { type: "bang_input"; data: string; id: string }
  | { type: "bang_kill"; id: string }
  // Connection liveness probe; the server answers `pong`. Lets the
  // browser detect a half-open socket (wifi blip with no FIN) and reconnect.
  | { type: "ping" }
  // This connection is a fleet watcher, not a session viewport —
  // it receives `sessions` snapshots instead of a transcript stream.
  | { type: "watch_sessions" }
  // Rename a session (fleet affordance).
  | { type: "rename"; sessionId: string; name: string }
  // Explicitly end a session — kill its PTY, close the engine, drop it from
  // the fleet, and kick any attached viewports back to mission control. Usable
  // from a session viewport or a fleet watcher.
  | { type: "end_session"; sessionId: string }
  // Cockpit acts — sessionId-addressed like end_session, so a fleet watcher
  // can act on a session without attaching. Acting from the grid grants
  // nothing a local viewport couldn't do by attaching; the two acts that
  // DRIVE the model (answer_permission's allow path, prompt_session) are
  // refused on a REMOTE (relay) connection when the session's credential
  // can't ride the paid relay — same rule as attach. interrupt_session
  // stays ungated, like end_session (teardown, not model use). Unknown
  // session ids answer with an `error`.
  | { type: "answer_permission"; sessionId: string; id: string; allow: boolean }
  | { type: "interrupt_session"; sessionId: string }
  | { type: "prompt_session"; sessionId: string; text: string }
  // Re-probe local model servers and re-send the `agents` hello. The
  // agent picker sends this on a slow interval while open, so the
  // "start your local server and it appears here" promise is live — no
  // reload. Server-side throttled; a burst degrades to the cached answer.
  | { type: "refresh_agents" }
  // An explicit user gesture asks the LOCAL daemon to open the host OS's
  // folder dialog. `cwd` is only the suggested starting directory; the daemon
  // validates it and returns the actual selected path in `folder_picked`.
  | { type: "pick_folder"; id: string; cwd?: string }
  // The manage-subscription card's three requests, each answered
  // by exactly one `subscription` reply with the echoed id. `status` reads;
  // `cancel` schedules an end-of-period cancellation (the confirm step is
  // the shell's, client-side); `uncancel` removes a scheduled one. Local
  // viewports only — a remote (relay) viewport gets an error reply, and
  // never the `billing` hello flag that draws the affordance.
  | { type: "subscription_status"; id: string }
  | { type: "subscription_cancel"; id: string }
  | { type: "subscription_uncancel"; id: string }
  // The read-only file browser's per-viewport queries. `id` is
  // client-minted (the bang-id grammar) so the issuing component can
  // correlate the one reply each request gets. The path is a REQUEST — the
  // server jails every resolution to the session root and refuses secret env
  // files; the client is never trusted with a path. Both types are throttled
  // per connection (throttled requests still get an error reply).
  | { type: "fs_list"; id: string }
  // All changed files, grouped by repository; answered as fs_change_set.
  // No path argument: the immutable session root is the scope.
  | { type: "fs_changes"; id: string }
  | { type: "fs_read"; id: string; path: string }
  // "What changed in this file" — answered as fs_file_diff. Same id
  // grammar, same jail, same throttle family as fs_read.
  | { type: "fs_diff"; id: string; path: string }
  // List ONE directory's children — the lazy tree's fetch unit,
  // answered as fs_dir. `path` is session-root-relative and /-separated
  // ("" or "." = the root itself); same id grammar and jail as fs_read.
  // Throttled as a token BUCKET, not the min-interval family: opening the
  // panel legitimately fetches root + first level in one burst, and a
  // single readdir is orders cheaper than the whole-tree walk fs_list pays.
  // fs_list/fs_tree stay untouched beside this — the app bundle and a
  // user's daemon can be version-skewed, so the whole-tree pair is the
  // compatibility floor, never removed here.
  | { type: "fs_listdir"; id: string; path: string }
  // File drag-and-drop input: a dropped file's bytes, chunked.
  // `begin` declares a sanitized display name and the exact total size (the
  // cap check runs before any byte arrives); `chunk.data` is base64, each
  // decoded chunk bounded well under MAX_WS_PAYLOAD; `abort` discards a
  // partial upload (a navigating page, a cancelled drop). Same id grammar
  // as fs correlation ids; per-connection state only.
  | { type: "file_upload_begin"; id: string; name: string; size: number }
  | { type: "file_upload_chunk"; id: string; data: string }
  | { type: "file_upload_abort"; id: string }
  // The browser half's uncaught errors (window "error"/"unhandledrejection"),
  // forwarded so the daemon's flight-recorder log hears about a front-end
  // crash — otherwise a "it went blank" bug report arrives with an empty log.
  // Client-clipped and capped per page;
  // the server re-caps per connection and treats the text as untrusted:
  // logged only, never broadcast, never echoed back into any surface.
  | { type: "client_error"; message: string; clientVersion?: string };

/** Why remote access is off (`agents.relayOff`) — declared once here. */
export type RelayOffReason = NonNullable<Extract<WireMsg, { type: "agents" }>["relayOff"]>;

/** The daemon's license-key read (`entitlement`), minus the tag — declared once here. */
export type EntitlementView = Omit<Extract<WireMsg, { type: "entitlement" }>, "type">;
