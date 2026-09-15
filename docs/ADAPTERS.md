# The Adapter Specification — multi-provider architecture, normatively

This is the authoritative contract for **adding or modifying an agent adapter**
in Mirafold. README.md orients a new owner; PLAN.md sequences the work; this
document states what an adapter **must, should, may, and must never** do, what
each shipped provider actually supports (the capability matrix), and the exact
checklist for landing the next provider. It exists so that a future session —
human or agent, on any model — can extend the provider surface without
re-deriving the architecture or violating an invariant that only lived in
someone's head.

Grounded in the shipped code through 2026-09-15 (four providers —
`claude-code`, `codex`, `gemini-cli`, `opencode` — plus `mock`). File
references are the source of truth if this document and the code ever disagree
— then fix this document.

---

## 1. The architecture in four sentences

Mirafold is a **faithful browser re-skin of terminal coding agents**. Each
supported agent runs its **own engine** behind one seam — the `AgentSession`
interface (`server/adapters/types.ts`) — and normalizes its native event stream
into the wire protocol (`WireMsg`, `server/protocol.ts`); everything downstream
(registry, replay buffer, security, front end, generative UI) consumes
`WireMsg` and nothing else. Generative UI is injected into each agent as **MCP
tools**, so the agent paints components through its own tool-calling machinery
rather than through any genui-specific protocol. Consequently a new provider is
**one adapter plus bounded seam registration** — never a provider-specific
branch scattered through shared code.

## 2. Invariants (violating any of these is an architecture bug)

These restate the CLAUDE.md non-negotiables as testable adapter requirements.

- **I1 — Faithful skin.** The adapter drives the provider's own engine
  (SDK/CLI/headless protocol). Never build a generic homegrown agent loop,
  never place a proxy in the request path, never make one agent's behavior leak
  into another's session. A Codex user gets Codex — model defaults, approval
  semantics, config files — never "Claude things".
- **I2 — Inherit, don't invent.** The user's own configuration for that agent
  (Claude Code `settings.json`/CLAUDE.md/memory through the Claude Agent SDK;
  Codex `~/.codex/config.toml`;
  Gemini `~/.gemini/settings.json`) applies exactly as in the terminal. The
  adapter adds only what Mirafold needs (the render MCP server, a model
  override *if the user set one*) and adds it non-destructively. The historical
  bug class here is real: `DEFAULT_MODEL` (a Claude id) was once handed to
  Codex, which 400s — hence `modelFor()` (§6) and the rule that an unset model
  means *pass nothing and let the agent use its own default*.
- **I3 — Optional-feature rule.** A capability the provider lacks simply never
  appears — no stub, no fake, no special case in shared code. No reasoning
  stream → `thinking_delta` never fires. No approval callback → no
  `permission_request`. The front end is already built to tolerate any subset.
- **I4 — Provider-native transcript fidelity.** Forward the provider state its
  own terminal makes useful (thinking, tool arguments/results, diffs,
  subagent progress, usage), but do not turn raw adapter/SDK churn into extra
  top-level transcript. The client keeps every message, every command, every
  edit, every failure, and every in-flight call visible as its own row, and
  groups only contiguous runs of **routine** work — reads, listings, and
  searches the ENGINE classified as such (`tool_use.actions`), completed
  without error or a nonzero exit — into one expandable record with the
  complete retained details in original order (Phase TF, R2). Prose of any
  length or phase is a boundary, never absorbed; a failure can never
  disappear into a success group; a batch (turn) change is a boundary too.
  Reasoning is collapsed from its first delta and reachable on demand (R1).
  A subagent's text/thinking rides its deck via `parentId` (Phase SA) and its
  lifecycle rides `task_update` (Phase TF, R4) — a finished spawn, wait, or
  poll call is never read as the child finishing.
- **I5 — Wire discipline.** Adapters only ever ADD to what travels on existing
  message types; existing `WireMsg` shapes never change. Adding a provider adds
  one value to the `AgentName` union — an additive wire change, allowed.
- **I6 — Secrets and configured destinations stay server-side.** Credentials
  are read from the environment or the provider's own auth files, per adapter,
  and are never serialized into a `WireMsg` or a `Backend` sent to the browser.
  Configured endpoint URLs are sensitive too (userinfo/query data can be
  authentication), so browser choices use an opaque daemon id. A discovered
  endpoint is revalidated against the current probe cache and receives neither
  real Anthropic credential variable. A configured Claude destination receives
  only the header-credential mode explicitly bound to that exact endpoint.
- **I7 — Agent-neutral shared code.** `protocol.ts`, `sessions/registry.ts`,
  the `security/permissions.ts` posture, `capOutput`, `toolDetail`, the render-tool schemas,
  and everything in `web/` must compile and behave identically with any
  adapter. If a provider needs a branch in shared code, the design is wrong —
  put the behavior in the adapter.

## 3. The `AgentSession` contract — semantics beyond the types

```ts
interface AgentSession {
  pushPrompt(text: string): void;
  onMessage(cb: (msg: SessionMsg) => void): void; // SessionMsg: the session-scoped subset of WireMsg
  interrupt(): void;
  resolvePermission(id: string, allow: boolean): void;
  readonly modelName: string | undefined;
  readonly resumeId?: string;
  onResumeId?(cb: (id: string) => void): void;
  onBackendKind?(cb: (update: { kind: CredentialKind; provider?: string }) => void): void;
  verifyBackendKind?(): Promise<void>;
  refreshPromptOptions?(): void;
  close(): void;
}
```

`modelName` is the best-known model label (`undefined` until the engine has
named one — the UI shows nothing rather than a stand-in). `onBackendKind` and
`verifyBackendKind` exist only for providers whose credential kind cannot be
known before the engine runs (§6 step 4b).

The TypeScript interface is necessary but not sufficient. The behavioral
contract each implementation must satisfy:

**Construction** — takes `{ workspaceDir, model?, resumeId? }` plus whatever
backend binding the provider needs (Claude: `kind`, `endpoint`, `endpointAuth`;
Codex: `kind`, `endpoint`, `provider`; see the concrete constructors). `workspaceDir`
is the session's real working directory (registry-owned; already validated).
`model` is the per-agent override from `modelFor()`; `undefined` means inherit
the agent's own default (I2). `resumeId`, when present, must reopen that exact
provider conversation with the provider's native resume mechanism. Construction
must not throw on a missing binary or bad credentials — surface those as an
`error` WireMsg on first use, so the viewport sees a readable failure instead
of a dead socket.

**Backend environment binding** — adapter construction receives an already
validated server-side `Backend`. Claude's `endpointSource` distinguishes a
configured destination from a probe-discovered one; `endpointAuth` is exactly
`api-key`, `auth-token`, or `none`. Build the SDK environment by first removing
`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN`, then add
back the exact destination and only its bound credential mode. `none` gets the
fixed dummy token required by Anthropic-compatible local servers. Never recover
an authenticated configured endpoint against a different current endpoint or
credential mode. A checkout-supplied endpoint may use only a credential that
the same constrained project configuration supplied; it cannot redirect a
parent-only daemon secret.

Configured destinations are sensitive diagnostic context too. Picker labels
must not derive their hostnames, and adapter error/notice paths must remove the
exact selected Claude endpoint or Codex provider base URL before emitting a
`WireMsg`; the generic registry/log scrubber is only the final backstop.

**`pushPrompt(text)`** — feeds one user turn. Must accept a prompt while a
turn is in flight: queue it (Claude: async-generator queue; Codex, Gemini,
OpenCode: a serial worker) rather than dropping or interleaving. The `!` bang transcript
arrives through this same method as prepended context — adapters need no bang
awareness (agent-neutral by design).

**`onMessage(cb)`** — the single output subscription. Per-turn message grammar
every adapter must honor:

1. Turn start: a `status {state:"thinking"}` promptly, so the activity line
   moves before first output.
2. Body, in the provider's own stream order: `thinking_delta`* /
   `text_delta`* / `tool_use`→`tool_result` pairs / `render` / `artifact` /
   `status` updates, plus an optional `notice` (F.2) for degraded-service
   events the provider surfaces (retry / compaction / rate-limit / refusal).
   `tool_result` may only be emitted for an `id` previously
   announced by a `tool_use`; results for unannounced ids are dropped.
   Every tool output passes through `capOutput()` and is spelled onto the
   result by `outputFields()` — the head as `output`, plus `tail`,
   `omittedBytes`, and `truncatedBytes` (honest, byte-based, never a silent
   cut) — and every `tool_use.detail` through `toolDetail()` (all in
   `adapters/types.ts`). `exitCode` and `durationMs` ride the result
   independently of `isError`: a command that ran and exited nonzero is a
   completed row with its exit annotated, not an error.
3. Turn end: `usage` (if the provider reports tokens) then **always**
   `turn_end` — including on provider errors (emit `error` first, then
   `turn_end`). A turn that ends without `turn_end` wedges the client's busy
   state; this is the most consequential single rule in the grammar.

Adapters must **never** emit registry-owned plumbing: `user_prompt`,
`session_created`, `agents`, `sessions`, `pong`, or any `bang_*` message, and
never stamp `seq` (the registry stamps it on broadcast — onto a shallow copy,
so adapters may assume broadcast never mutates their emitted objects).

**`resumeId` / `onResumeId(cb)`** — expose the provider's real durable
conversation identity, never a Mirafold-only surrogate. A restored adapter may
return the supplied id immediately. A new adapter whose id is not resumable
until engine initialization returns `undefined` first and invokes
`onResumeId` at the exact readiness event (Claude system/init, Codex
`thread/started`, Gemini's first valid stream event). The registry checkpoints
that event synchronously; a later arbitrary tool/text message is not a safe
substitute.

**`refreshPromptOptions()`** — when the provider terminal has pre-submit
commands, emit one replaceable `prompt_options` catalog rather than waiting
for the user to submit a partial command. Every advertised command must be
intercepted and executed as that command on the adapter's active drive surface;
never copy a TUI/ACP catalog onto an SDK/stream-json surface that will send the
text to the model as prose. Today Claude uses SDK `supportedCommands()` plus
`commands_changed`; Codex emits its shell-reimplemented `/model` and `/effort`
plus live app-server `skills/list` for `$`; Gemini emits its shell-reimplemented
`/model`; OpenCode emits `/model` and `/agent` plus the engine's own catalog.
Catalogs are shell metadata, not sequenced transcript history, and must fail
soft without inventing provider commands. Any provider/workspace-supplied
catalog text must carry a fixed adapter-assigned `PromptOption.source` (Claude
commands → `claude-code`; Codex skills → `codex`) so trusted prompt chrome
renders an attribution badge. Never copy a source label from provider metadata.
The registry drops an entire option containing line, direction, or invisible
display controls rather than rewriting the command value.

**`interrupt()`** — halt the in-flight turn using the provider's own mechanism
(Claude SDK `interrupt()`; Codex a `turn/interrupt` request with a process
kill if the turn has not ended within `MIRAFOLD_CODEX_INTERRUPT_GRACE_MS`,
5 s; OpenCode `POST /session/:id/abort` with the same kind of grace,
`MIRAFOLD_OPENCODE_INTERRUPT_GRACE_MS`; Gemini child-process kill); the
session stays warm for the next prompt. Any pending permission requests
are denied. Must be a no-op when idle.

**`resolvePermission(id, allow)`** — completes a previously emitted
`permission_request`. Only meaningful for providers whose engine exposes an
approval surface (today: the Claude Agent SDK via `canUseTool`, Codex via its
app-server `item/*/requestApproval` requests, OpenCode via
`permission.asked`, plus the one-time workspace-trust ask Codex and Gemini
raise before their first spawn); Gemini's headless stream has no approval
surface, so there it is a no-op (I3). Deny is the default posture on timeout
(`PERMISSION_TIMEOUT_MS`, default 60 s; the trust asks use their own longer
`TRUST_PROMPT_TIMEOUT_MS`, 5 min), disconnect, and interrupt. An
adapter that emits `permission_request` MUST also emit `permission_resolved
{ id, allow }` for EVERY resolution path — answer, timeout, interrupt — so
every attached viewport drops its bar the moment the ask dies instead of
holding a stale prompt a tap can only no-op against. Use `PermissionLedger`
(`wire-helpers.ts`) — every path funnels through its one `finish`, so the rule
is structural rather than remembered per adapter.

**`close()`** — idempotent teardown: end generators, abort turns, kill child
processes, clear timers. After `close()`, no further messages may be emitted.

**The subagent lane (Phase SA)** — when the engine spawns its own subagents,
the adapter maps them onto the neutral lane instead of dropping or flattening
them. The rules, for the next adapter author:

- **`parentId` is an opaque adapter-chosen handle.** The Claude Agent SDK uses
  the spawn `tool_use` id; OpenCode uses the parent `task` PART id. Shared code
  (registry, client, replay) only ever GROUPS by it — nothing parses,
  dereferences, or compares it across adapters. Pick whatever your engine's
  natural join key is.
- **The deck anchors on the relationship, never a tool name.** The client
  turns "a tool_use other records reference as `parentId`" into a live
  subagent deck (GLOSSARY). Engines whose spawn is not a tool call (Codex's
  collab threads, if mapped post-F.5) would need a spawn record for the deck
  to anchor on — the requirement is named here so the deck component never
  grows a name check.
- **Prose is budget-capped per subagent.** Every forwarded subagent
  text/thinking chunk passes `SubagentProseBudget` (`adapters/types.ts`;
  `SUBAGENT_TEXT_CAP_BYTES`, default 64 KB) — one explicit elision marker at
  exhaustion, never a silent cut, ledger cleared each turn. The ledger also
  caps DISTINCT subagents per turn (audit 2026-08-14 flood parity): past it
  a new parent id's prose drops silently, like every other per-turn cap.
  This bounds what one subagent — or a fabricating engine — can add to the
  wire, the replay ring, and relay bytes.
- **Prose renders inert.** Subagent words paint as plain text inside the
  deck's expansion — never markdown, never top-level transcript (they must
  not fold the parent's thinking, steer the activity label, or land in the
  turn-end announcement).
- **A subagent's render call never paints.** Paintings are session-level;
  inside a deck it gets the honest `tool_use`/`tool_result` record. On
  OpenCode this is our lane code; the Claude Agent SDK's runtime enforces it —
  the SDK withholds MCP tools from subagent contexts (proved through the
  real adapter + shipped in-process render server, audit 2026-08-14).
- **A subagent's permission ask surfaces on the shell bar** with `parentId`
  when the engine can attribute it (OpenCode can; the Claude Agent SDK's
  `canUseTool` callback carries no subagent identity, so its asks ride
  unattributed), and the same deny-by-default timer as any ask. A child's
  lifecycle events (idle, status, error) must never touch the parent turn's
  state — its failure surfaces through the spawn record's result.
- **Render depth 1 — what the stream surfaces.** Engines nest deeper
  (the Claude Agent SDK nests to depth 3, engine-hidden; OpenCode only if the
  user configures it). Resolve parentage transitively to the nearest
  stream-visible ancestor's deck; engine-hidden grandchildren are the
  ENGINE's choice, faithfully absent.

## 4. Capability matrix (shipped providers, as implemented)

| Capability | `claude-code` | `codex` | `opencode` | `gemini-cli` | `mock` |
|---|---|---|---|---|---|
| Drive surface | `@anthropic-ai/claude-agent-sdk`, one warm `query()` for the session's life | the user's installed `codex` CLI's **`app-server` JSON-RPC** protocol (the surface the Codex TUI and VS Code extension use), spoken RAW over stdio (no SDK — `codex-app-server.ts` is the transport), one long-lived process + one warm thread, `turn/start` per turn | one `opencode serve` **HTTP + server-sent-events** server per session, spoken RAW (no SDK — the published types drift from the live server); `opencode-client.ts` is the transport | `gemini` CLI headless: `-p … -o stream-json`, one process **per turn** | scripted timers |
| Warm-conversation mechanism | never-ending query + async prompt queue (prompt cache preserved) | persistent `Thread` (`thread.id` resumable) | server-side session (`ses_…`) persists across turns; the HTTP server stays up for the session | `--session-id` first turn, `--resume` after | n/a |
| Daemon-restart resume id | SDK `session_id` after init; restored with `resume` | the `thread/start` thread id; restored with `thread/resume` (a crashed process respawns and resumes by id on the next prompt) | the engine session id; a fresh `opencode serve` reattaches it when `sessionExists`, else recreates | accepted UUID; restored with `--resume` (fatal id-mode self-heals) | transcript only |
| Pre-submit catalog | live SDK slash commands + `commands_changed` | implemented `/model` + `/effort` + live app-server `$` skills | implemented `/model` + `/agent` (build/plan/custom) + the engine's own `/command` catalog (badged `source:"opencode"`) | implemented `/model` | scripted supported catalog |
| Text streaming granularity | token-level (`includePartialMessages`) | token-level (`item/agentMessage/delta`), held only from a code fence on so a hand-written chart still converts | token-level: a true delta channel (`message.part.delta`) plus snapshot accrual | chunked `message` events | 16-char chunks |
| Thinking stream (`thinking_delta`) | ✅ full fidelity | ✅ when reasoning items appear | ✅ (`reasoning` parts) | ❌ observed absent → never fires (I3 proof) | ✅ scripted |
| Tool records (`tool_use`/`tool_result`) | ✅ full input, diffs; `Read`/`Glob`/`Grep`/`LS`/`NotebookRead` classify as routine by exact name (`actions`) | ✅ (`command_execution`, `file_change`, `mcp_tool_call`, `web_search`; only `status: "failed"` WITHOUT an exit code maps to `isError` — a command that ran keeps `isError: false` and carries its own `exitCode` and `durationMs` as facts, badged "exit N" on the row, matching the Codex TUI; the engine's parsed `commandActions` classify a command as routine only when EVERY action is a read/listing/search) | ✅ (tool parts; built-in `write`/`edit` normalize to the shared `Write` code painter / `Edit` diff painter with workspace-relative paths; `read`/`glob`/`list`/`grep` classify by exact name; error output capped by `capOutput` like success; an interrupted tool keeps its observed output ahead of the error) | ✅ (`read_file`/`read_many_files`/`glob`/`list_directory`/`grep_search` classify by exact name; no exit codes or durations exist on the headless stream) | ✅ |
| Live output of a running call (`tool_output_delta` + `tool_output_snapshot`; Phase TF R7) | ❌ the SDK streams no tool stdout — `tool_progress` carries elapsed seconds only, forwarded as `tool_update.elapsedMs`, never shown as output | ✅ `item/commandExecution/outputDelta`, plus `item/mcpToolCall/progress` lines and the agent's own `terminalInteraction` stdin (marked `‹stdin›`) — through the shared bounded `LiveOutput` accumulator | ✅ the bash tool's running `metadata.output` (the whole output so far, verified in 1.18.29) → suffix-only forwarding as replacement snapshots | ❌ absent on the headless stream (`capabilities.liveOutput: false` — the row says "live output unavailable" instead of implying silence means nothing happened) | ✅ scripted snapshots |
| Task lifecycle (`task_update`; Phase TF R4) | ✅ `task_started`/`task_progress`/`task_notification`/`task_updated` on the spawn's `tool_use_id` (a task the SDK ties to no call gets a task-scoped anchor; `skip_transcript` tasks stay hidden); `TaskOutput`/`TaskStop` are ordinary rows with inspectable results | ✅ a spawn's child is `running` from `item/started`; every `agentsStates` entry (spawn, wait, send…) updates the same anchor with the FULL message as the report; `subAgentActivity` kinds map to running/completed/interrupted | ✅ the task part's lifecycle: child `session.status busy` → running; the part settling → completed (report = its output) / failed; a child `session.error` → failed | ❌ no task lane | ✅ scripted |
| Subagent lane (`parentId` on calls, prose, asks — the subagent deck; Phase SA) | ✅ calls (`parent_tool_use_id`) + prose from parent-tagged COMPLETE messages (the SDK never streams subagent token deltas — SA.0 probe), budget-capped; asks ride the parent `canUseTool` unattributed. Verified live 2026-09-15 (SDK 0.3.201): `task_started.tool_use_id` IS the Agent call's id and child frames carry it as `parent_tool_use_id` | ✅ full lane (verified live 2026-09-15, app-server 0.153.4, `multi_agent` stable): a spawn surfaces as `subAgentActivity started` (no collab spawn item in this version), which anchors the child on an opaque `codex-agent:<thread>` handle; the child thread's own items — reasoning, prose, commands with `commandActions`/`exitCode` — arrive on the PARENT connection under the child's thread id and ride the lane via `parentId`; its final `agentMessage` is the task's report (retained already capped, released at the engine's terminal word); the parent's `wait` collab call is its own row. Collab calls that DO name receivers keep their collab anchor. A child's `turn/completed` never ends the parent's turn, and a child that outlives the parent's turn (a spawn with no wait) keeps riding the lane until its own completion settles the task. A child's render, image, dynamic-tool, and sleep calls are honest parented records — never a painting; a child's own spawn adopts the grandchild under the same deck (the nearest visible ancestor) with no deck of its own; past a per-session child-item cap further child items are dropped whole and said so once, never promoted to root output; a child's typed stdin, MCP progress, and patch snapshots ride its running rows; a child's approval ask carries its deck's `parentId` and survives the root turn's end (its own timeout bounds it); a child's terminal word flushes its streaming rows first; a child turn that ends `failed` is a failed task carrying the engine's capped diagnostic (the activity item's later "completed" does not undo it); an app-server exit gives every preserved child a terminal `interrupted` word; a child's written plan is commentary in its lane; the synthetic anchor is bounded to the checkpoint id budget; nothing is emitted after `close()`. Shared rule for every adapter with background children: subagent traffic after the root `turn_end` never re-marks the session busy/working in either reducer (PR #122 review) | ✅ full lane: child sessions on the same global stream map to the spawn part id (`state.metadata.sessionId` join, transitive for configured nesting), prose budget-capped, `permission.asked` surfaced ATTRIBUTED (`permission_request.parentId`) and replied via the session-agnostic `POST /permission/{requestID}/reply`; a child's render call gets an honest tool record, never a painting | ❌ the headless stream exposes no subagent lane | ✅ scripted three-spawn fan-out with narration |
| Live todo checklist (`render` todo-list) | ✅ (TaskCreate/Update fold) | ✅ (`todo_list` item) | ✅ (`todo.updated`) | ❌ | ✅ |
| Interactive permissions (`permission_request`) | ✅ full round-trip via `canUseTool` + inherited `settings.json` | ✅ full round-trip: `item/*/requestApproval` → the bar → `{decision}` / granted profile; fail-closed on timeout/close; PLUS a folder-trust ask before the first `thread/start` | ✅ full round-trip: `permission.asked` → reply `once`/`reject` (never `always` — that would persist into the user's own OpenCode state) | ❌ headless can't prompt → user's own tool approvals inherited; only the injected render-server entry carries `trust: true` | ✅ (`dangerous` keyword) |
| Usage (`usage` msg) | ✅ tokens + cumulative `total_cost_usd` | ✅ one `usage` per turn from `thread/tokenUsage/updated` (the delta of the thread totals; output = `outputTokens` + `reasoningOutputTokens`; no cached-token field is read) | ✅ tokens + cost per assistant message, summed into one per-turn `usage` | ✅ per-model token breakdown | ✅ |
| Interrupt | SDK `interrupt()` | `turn/interrupt`; discovered-local turns also use it at the configurable eight-minute outer deadline | `POST /session/:id/abort`; the grace deadline starts independently of that finite HTTP call. If idle misses the deadline, fork the conversation to a new engine-session id before the next prompt so a late old idle cannot end it; bounded fork failure degrades to a disclosed fresh session | kill child process | clear timers |
| Render-MCP injection | **in-process** SDK MCP server (`render-tools.ts`) | required subprocess stdio MCP via `-c mcp_servers.*` on the app-server spawn (`render-mcp.ts`); `thread/start` rejects before inference on failure | subprocess stdio MCP via the **`OPENCODE_CONFIG_CONTENT` env var** (additive merge; no file the user owns is read, written, or created); startup waits for `GET /mcp` to report it connected | subprocess stdio MCP via **per-session `<cwd>/.gemini/settings.json`** (merged non-destructively; note: drops a file in the user's project dir) | emits `render` directly |
| Model override env | `DEFAULT_MODEL` | `CODEX_MODEL` | `OPENCODE_MODEL` (`provider/model`; a bare id can't name a provider so it pins nothing) | `GEMINI_MODEL` | — |
| Credential signal (`agentHasCredentials`) | `ANTHROPIC_API_KEY` \|\| `ANTHROPIC_AUTH_TOKEN` \|\| `ANTHROPIC_BASE_URL`; a `~/.claude/.credentials.json` login is detected only so the picker can name the fix — provider policy blocks it | in order: a non-`openai` default `model_provider` in `$CODEX_HOME/config.toml` → `local`; `OPENAI_API_KEY` → `api-key`; `$CODEX_HOME/auth.json` (ChatGPT login) → `subscription` | binary present: a stored `auth.json` → `api-key`, else the free Zen gateway → `gateway`; the TRUE per-provider kind is classified at session start from the running engine's catalog | `GEMINI_API_KEY` \|\| `GOOGLE_API_KEY` \|\| `$GEMINI_CLI_HOME/.gemini/oauth_creds.json` (home prefix defaults to the user home; existence only, native CLI checks account access) | none → mock is the fallback for every agent |

Known asymmetries, accepted deliberately (each is I3 at work, not debt):
Gemini has no thinking stream, pays a process spawn per turn, and its
`stream-json` surface exposes no per-server MCP startup status. Codex moved to
the `app-server` protocol (Phase CA, 2026-08-25), which closed its two old
gaps — it now streams token deltas and carries the interactive approval
round-trip — so Codex's permission bar is live; what a headless Gemini still
cannot do, it still cannot.

**Codex executable parity (F.10, 2026-08-08; app-server since CA):**
`CodexSession` resolves the user's installed `codex` executable (including
`MIRAFOLD_CODEX_BIN`) and runs its `app-server`. There is no bundled-engine
fallback any more — the SDK is gone; a missing binary ENOENTs the first turn
honestly. Turns, `/model`, and engine-default resolution all query that one
resolved executable. This is load-bearing: two
Codex versions share `~/.codex/config.toml` and `models_cache.json`; letting a
newer terminal write those files while an older SDK engine reads them caused a
cache-schema failure, an older fallback model, and an invalid inherited
reasoning effort. Do not reintroduce separate "picker" and "engine" binaries.

**Codex discovered-local completion bound (L.4, 2026-08-11):** a real
Codex→Ollama trace proved that the former silent Tier-4 timeout was not an
adapter event-delivery stall. Ollama was pre-filling the full Codex prompt on
CPU, then Qwen was generating a long reasoning item, held until completion. `CodexSession` therefore preserves the user's reasoning
default, exposes the Codex/Ollama-proven `none` extension only on a discovered
local endpoint, and places an eight-minute outer bound around those turns. The
bound goes through the same `interrupt()` path as a user stop and emits one
actionable error before the required single `turn_end`; configured providers
and first-party sessions receive neither override nor deadline. The deadline
is `MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS` (`0` disables it).

## 5. Generative UI: the MCP contract

The render tools (`render_card/list/table/chart/links/keyvalue/progress/timeline/filetree/question/diff/stat/code/statuslist/console/image/diagram`, `emit_artifact`) are
defined once — the one list is `RENDER_TOOL_COMPONENT` in `render-mcp-cmd.ts`,
schemas in `server/registry-spec.ts` — and delivered two ways:

- **In-process** (Claude only): `server/render-tools.ts` handed to `query()`.
- **Standalone stdio process** (everything else — Codex, OpenCode, Gemini):
  `server/render-mcp.ts`, spawned via `renderMcpCommand()` (`render-mcp-cmd.ts`)
  — compiled twin when present, `tsx` + source in dev.

**Delivered is not the same as visible.** Both first-party engines now hide
MCP tool definitions from the model by default, and a model that has to hunt
for a tool rarely paints (Phase TS, 2026-08-30):

- The Claude Agent SDK defers every MCP tool behind `ToolSearch` (on by
  default since Claude Code 2.1.x). `render-tools.ts` marks the `ui` server
  `alwaysLoad: true`, which is the SDK's per-server exemption
  (`_meta["anthropic/alwaysLoad"]` on each tool): Mirafold's tools are in
  the prompt from turn one, and the user's own MCP servers keep whatever
  deferral their terminal Claude Code applies. Measured: with the exemption
  Claude paints without a search round-trip; without it, it searches first.
- Codex has no exemption. On an OpenAI provider it either defers MCP tools
  behind `tool_search` (≤0.149) or exposes them only inside its `exec`
  JavaScript runtime as `tools.mcp__mirafold__<name>(args)`, discovered via
  `ALL_TOOLS` (≥0.147; custom/local providers still see them directly). The
  adapter's developer instructions therefore open with a where-are-the-tools
  note (`server/adapters/codex/codex-prompt.ts`) that names all three paths
  with exact call shapes
  and makes loading the tool the first step of any structured reply. The note
  also forbids resource-list APIs as tool discovery and stops after one failed
  pass; it never tells the model that an absent tool is secretly present.
  A 16-turn replay of real prompts (PLAN TS.3) measured that note — and a
  per-turn paint reminder tried after it (TS.5, reverted) — as no-ops:
  Codex paints on early advisory turns and then answers in prose for the
  rest of a working session whatever the instructions say. Prompting is
  not the lever; what the transcript shows of the engine's own work is.

**Nothing the engine sends is dropped silently (TS.7).** Each adapter's
dispatcher has a default branch: an item, event, or message kind with no
mapping is logged and surfaced once per session as a shell-voiced notice
("Mirafold doesn't display this Codex item yet: …"), never swallowed. Each
adapter's ledger — what it maps, what it deliberately ignores and why —
lives beside it (`codex/codex-ledger.ts`, `opencode/opencode-ledger.ts`;
Claude's is
`CLAUDE_MESSAGE_LEDGER` in its adapter). For Codex the ledger is held to the
engine's own protocol: `scripts/codex-protocol-digest.mjs` distills
`codex app-server generate-json-schema`
into `server/adapters/codex/codex-protocol.digest.json` (item kinds,
notification methods, the field shapes the adapter reads);
`codex/codex-protocol.test.ts`
asserts every kind is handled, deliberately ignored (with a reason), or
unmapped with a plan step, and that the read fields still have the shapes the
adapter assumes; the Tier-4 live test regenerates the digest from the
installed Codex and fails on drift. Claude's ledger is compile-time
(`CLAUDE_MESSAGE_LEDGER satisfies Record<SDKMessage["type"], …>`). OpenCode's
Tier-4 gate pulls the installed server's own OpenAPI document and applies the
same handled / deliberately ignored / planned classification to every event
and message-part kind; its live gate separately proves which advertised
surface the production `/event` feed actually emits. Gemini's finite
`stream-json` switch reports every event outside its handled set; no benign
extra kinds have been observed that warrant a separate ignore ledger.

A successful Mirafold render-tool call is represented by its painting, not a
duplicate raw row. A failed or unsynthesizable render call is still engine
activity: every adapter falls back to an ordinary `tool_use` + error/result
row so the attempted action and failure cannot disappear.

**Narration is not the answer (TS.8, revised by Phase TF R1).**
`text_delta.phase` (additive) carries the engine's own classification of its
prose: Codex declares every message `commentary` (interim narration — 7 of 8
of its messages) or `final_answer`. The browser keeps BOTH as readable rows
in chronological order — commentary in modest secondary styling at normal
contrast, the final answer at full weight — and never absorbs a message into
a tool group on the strength of its phase or its length (the pre-TF fold and
its two-line/160-character heuristic are gone). Codex's written `plan`
streams as commentary too.

Both coalescing seams treat `phase` as part of a prose lane and preserve it:
the daemon's 33 ms replay-ring window and the browser's animation-frame queue
can merge commentary with commentary, never commentary with a final answer.

**Live tool updates (TS.11, extended by Phase TF R7).** Two additive
messages carry a running call's output: `tool_output_delta` — the bounded
legacy prefix, batched by `(tool id, parentId)` at both coalescing seams and
capped at the same UTF-8 byte budget as final output, kept for clients that
predate snapshots — and `tool_output_snapshot`, a REPLACEMENT of everything
observed so far (a fixed head, the newest tail, the omitted middle counted,
a monotonic `revision`) sent at most four times a second per call with an
immediate final flush before the result. Every streaming adapter goes
through `server/adapters/live-output.ts`; the ring retains one snapshot per
call; a viewport ignores a snapshot whose revision is not newer than what it
holds. A collapsed command row previews the last three non-empty lines; its
expansion shows head, an explicit omission notice, and tail; `tool_result`
still closes it with the engine's authoritative output, and an interrupted
call keeps its last snapshot as evidence.

**Bounded, honest evidence (Phase TF R7).** `capOutput` keeps a UTF-8-safe
HEAD and TAIL of a large result within the budget (`TOOL_OUTPUT_CAP_BYTES`,
64,000 by default; the head gets the odd byte): `tool_result.output` is the
head — the same field a pre-TF client reads, now half the budget long rather
than all of it (a deliberate trade: one budget, both ends of the evidence) —
`truncatedBytes` still counts every byte past it, and
`tail` / `omittedBytes` carry the trailing text and the dropped middle. The
counts are of what THIS cap dropped — never a guess at what the engine
already truncated. Task reports use the same shape (`report`,
`reportTail`, `reportOmittedBytes`). The replay ring keeps its existing
count and byte caps; a full replay past evicted history carries
`replay_complete.evicted`, and an outcome whose opening row was evicted
becomes an explicit "(earlier call)" record rather than vanishing. There is
no complete-history promise and no log archive.

**Declared capabilities (Phase TF R8).** `session_created.capabilities`
(`server/adapters/capabilities.ts`) states per adapter whether live output,
thinking, task lifecycle, and a task's own child activity can appear. A
`false` is a verified absence at the adapter's interface, recorded above,
so the shell can say "live output unavailable for this agent" or "this
agent does not report a task's own calls" instead of implying that silence
means nothing happened. An available event that stays unmapped is unfinished
work, never a capability limit.

Current Codex does not emit the deprecated `item/fileChange/outputDelta`.
Its stable `item/started` / `item/completed` file-change items carry structured
changes, and the completed item is the authoritative full diff. Codex also has
an intermediate `item/fileChange/patchUpdated` snapshot behind the
under-development `apply_patch_streaming_events` feature. Mirafold does not
enable that unstable feature: Codex 0.152 intentionally warns whenever a
client does. The mapper still accepts `patchUpdated` if the user's own engine
emits it, using additive `tool_update` to refresh the open row, but final diff
painting never depends on it. The retired textual event remains accepted only
for older Codex version skew.

**Edit painting (TS.6).** `Write` shows the new content; `Edit` and the
registry's `render_diff` share the line differ; Codex `apply_patch` shows one
normalized block per file from the stable completed item (and refreshes it
earlier when the engine happens to emit live patch snapshots).
Unified-diff file headers are ignored only before
the first hunk, so changed source beginning with `--` or `++` remains visible,
and a move heading names both paths. The shared differ trims equal edges and
caps its LCS matrix at one million changed-middle cells; over that threshold
it shows every old middle line removed and every new middle line added. The
fallback is intentionally less minimal, but linear and lossless.

Adapter obligations for either path:

1. Auto-allow **only our** render server (Claude: `mcp__ui__*` in
   `server/security/permissions.ts`; Codex: per-server `default_tools_approval_mode`; OpenCode:
   the render server is the only MCP added via `OPENCODE_CONFIG_CONTENT` and the
   user's own permission rules otherwise apply; Gemini: `trust: true` on only
   the injected project entry). Never pass Gemini's
   `--allowed-mcp-server-names mirafold`: that flag is a server allowlist and
   silently removes every user-configured MCP server. Never blanket-approve the user's other
   tools to make ours run — that's forcing a posture the terminal doesn't have.
   OpenCode advertises MCP tools as `mirafold_<tool>`, so the adapter recognizes
   its own render calls by the `mirafold_` prefix and paints them, suppressing
   the raw tool rows.
2. On success, suppress the raw `tool_use`/`tool_result` rows for our render
   server's calls and emit the corresponding `render`/`artifact` WireMsg
   instead (the shared `generativeUIMsg` path). On failure—or if synthesis
   cannot produce a validated painting—fall back to the ordinary tool record;
   other MCP servers' calls always surface that way.
3. Re-sending a render `id` is an in-place update — adapters must paint under
   the id the agent will re-send, provided it fits `RENDER_ID_GRAMMAR`
   (1–128 characters of letters, digits, `_ . : -`; the guidance tells the
   model so, and an id outside it is replaced by a fresh uuid everywhere —
   the in-process server, the stdio stub's ack, and `renderIdFor`, 2026-08-26).
   `renderIdFor()` in `render-mcp-cmd.ts` is the
   one precedence (stub structured ack → the call's `id` argument → the ack
   text → a fresh uuid); every stdio adapter feeds it its channels rather than
   parsing the ack itself.

## 6. Adding the next provider — the checklist

**OpenCode was provider #4** (Phase OC, `server/adapters/opencode/opencode.ts` +
its neighboring client, event, and command modules) and is the most recent
worked example — its spike doc
`server/adapters/opencode/opencode.spike.md` shows the capture-live discipline,
and it exercised the seam differently enough to reveal two touchpoints the
earlier providers never needed (see step 4b below). The
proven sequence (used for Codex, Gemini, and OpenCode; keep it):

1. **Spike first** (`server/adapters/<agent>/<agent>.spike.md`): identify the
   drive surface (official SDK > headless JSONL > ACP-style protocol > raw stdio, in
   order of preference), confirm it can run as its *own engine* with streamed
   events and native MCP loading, and draft the event→`WireMsg` mapping table.
   A provider that cannot load MCP servers cannot carry generative UI — that's
   a red verdict, not a workaround invitation.
2. **Capture real events live** before writing the adapter. Both spikes found
   the docs wrong in the details (Codex: dot-notation event names, buffered
   deltas; Gemini: individual-account authentication removed). One throwaway probe saves a rewrite.
3. **Write the adapter** (`server/adapters/<agent>/<agent>.ts`), template:
   `server/adapters/codex/codex.ts` (app-server JSON-RPC) or
   `server/adapters/gemini-cli/gemini-cli.ts` (headless CLI). Identify the native
   durable conversation id/resume call and any pre-submit command discovery
   surface at the same time; honor every rule in §3.
3b. **Emit what the compact transcript needs (Phase TF).** Classify routine
   work only from the engine's own signal — an exact tool-name table in
   `adapters/routine-actions.ts` or a structured field such as Codex's
   `commandActions` — and put it on `tool_use.actions`; never infer it from
   shell text. Route a running call's output through `LiveOutput`
   (`adapters/live-output.ts`: `append`/`replace`/`settle`/`clear`) so
   snapshots stay throttled and bounded. Spell every result with
   `outputFields(capOutput(...))`, carrying `exitCode`/`durationMs` when the
   engine reports them. For subagents and background work emit `task_update`
   with the ENGINE's own state word — never a state you guessed — and the
   retained report through the same cap. A capability the adapter lacks is
   recorded as `false` in `adapters/capabilities.ts` with the probe that
   established it (the `Required<AgentCapabilities>` type makes a missing row
   a compile error).
4. **Wire the seam** — the compiler enforces most of it: every
   `Record<AgentName, …>` table fails typecheck until the new name has a row.
   Server: `protocol.ts` (`AgentName` union, additive); `adapters/index.ts`
   (`probe` entry, `credentialKind()` case — what counts as live —
   `backendOptions()` case — the picker's menu of ways it can run —
   `modelFor()` case — its own env var, never a shared one — `defaultAgent()`
   order, `ADAPTER_AGENTS` entry so the agent picker offers it,
   `AGENT_DIALECT` — which local-server dialect it can drive, or `null` —
   and the `createSession()` case); `adapters/capabilities.ts`
   (`AGENT_CAPABILITIES` row); `adapters/routine-actions.ts` (`TABLES` row,
   `{}` if the engine classifies its own commands). Browser:
   `web/src/agents-meta.ts` — the human label and connect/blocked hints
   (`LABEL`, `CONNECT_HINT`, `BLOCKED_HINT`) plus `backendLabel()` and
   `localCapable()`. This is display copy, not behavior — shared code still
   never branches on the agent name.
4b. **Only if the provider's credential kind can change mid-session or isn't
   knowable at hello time** (OpenCode is the first such — its kind is a fact
   about the underlying provider, resolved from the running engine and mutable
   by a `/model` switch): use the optional `onBackendKind(cb)` seam on
   `AgentSession`. The adapter publishes the classified kind at session start
   (and on a provider switch); the registry adopts it and holds the entry
   `kindPending` until the first publish, so the relay gate refuses remote
   viewports meanwhile. Pair it with the optional `verifyBackendKind()` seam
   (Phase RC): classify NOW instead of at the first turn, resolving once the
   truthful kind has published and rejecting with the honest user-facing
   reason when it can't. The create path uses it so a REMOTE create of a
   pending-kind session awaits the truth (bounded, `VERIFY_KIND_TIMEOUT_MS`)
   instead of losing the classification race; without the seam, remote
   viewports can only attach after a first local turn. The relay gate (`provider-policy.ts` `relayGateRefusal`)
   is then checked at **drive time on every model-driving path**, not only at
   attach — a mid-session flip to a `subscription`/`gateway` kind must never let
   an already-attached relay viewport keep driving (2026-08-13 audit). If the
   provider introduces a new credential kind, it goes in the `CredentialKind`
   union in `provider-policy.ts` and, if it must never cross the paid relay,
   stays off `allowedOverRelay`'s allow-list (which fails closed by default).
5. **Verify**: `yarn typecheck`; normalization unit tests beside the mapping
   (`normalizers.test.ts` pattern); then live — one turn with text, one tool
   call rendered as `tool_use`/`tool_result`, one render component painted via
   MCP, usage in the status bar, warm turn-2 recall, interrupt mid-turn, native
   command completion before submit, and process restart followed by resume of
   the same provider conversation id. Shared code (protocol, registry, security,
   output zone, generative UI) should need **zero provider-specific branches**;
   if it does, stop and re-read §2.

## 7. Local models (Phase L) — the settled posture

Locked 2026-07-05, restated here because it is the standing answer to "how do
we support provider X that isn't a terminal agent":

**Local isn't a Mirafold feature; it's a property of the agent.** An agent whose
underlying engine can point at a local OpenAI-compatible endpoint (Codex →
Ollama/vLLM/LM Studio; Claude Agent → `ANTHROPIC_BASE_URL` through the SDK's
bundled Claude Code runtime — already counted as "live" by
`agentHasCredentials`) already runs locally, and Mirafold simply re-skins it.
**No LiteLLM, no shim, no homegrown loop for bare models.** Phase
L is documentation and ergonomics (`docs/local-models.md`, and the
well-known-port discovery in `server/local-models.ts` that puts a running
local server in the picker), not architecture. Small models that misfire on render tools
degrade to styled text via the Step 1.4 fallback — best-effort by design, no
curated model gate. The same logic answers future requests: if something ships
a terminal agent, it gets an adapter; if it's a bare inference endpoint, it
enters through an agent that can point at it.

## 8. Divergence log

Deviations a reviewer might flag, with why they stand:

- **Gemini writes `<cwd>/.gemini/settings.json` into the user's project.**
  Required for per-session MCP injection (Gemini merges project over global —
  the non-destructive option). It happens only after the user answers the
  folder-trust ask, and that ask says so in its own text (render tools +
  API-key auth merged into this folder's `.gemini/settings.json`, which
  terminal Gemini reads too) — consent to the write is explicit, not implied
  by "trust". Every write opens with `O_NOFOLLOW` (the invalid-JSON backup
  exclusively) and `.gemini` must be a real directory: a checkout that ships
  `settings.json`, the backup's name beside it, or `.gemini` as a symlink (a
  dangling one passes `existsSync`) would otherwise redirect the consented
  write — or the repo's own bytes — to any user-owned path, so the turn
  refuses instead (2026-08-26 audit; a hardlink, which git cannot deliver,
  is the accepted residual as for the daemon's `.env` guard). `/model`
  sits behind the same trust ask, because its catalog is read by spawning
  Gemini in the folder. Documented in
  [ARCHITECTURE.md](ARCHITECTURE.md#agent-adapters); acceptable, but any
  alternative that appears in a future Gemini version (CLI flag for an extra
  MCP server) should replace it.
- **Gemini spawns one process per turn** while Claude/Codex hold a warm
  process. Faithful to the headless surface; `--session-id`/`--resume` carries
  the conversation. ACP (`--acp`) is the noted upgrade path if stream-json
  proves limiting.
- **Codex approvals ride the app-server protocol** (Phase CA): the engine's
  `item/*/requestApproval` requests become `permission_request`s on the bar,
  fail-closed. The user's own sandbox/approval config still governs WHICH
  actions ask — Mirafold sets none — so what the sandbox blocks, Codex asks,
  exactly as in the terminal.
- **`ANTHROPIC_BASE_URL` counts as live** with no key — deliberate, so
  proxy/local-endpoint setups don't silently fall into the mock.
