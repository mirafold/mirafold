# The Adapter Specification — multi-provider architecture, normatively

This is the authoritative contract for **adding or modifying an agent adapter**
in Mirafold. README.md orients a new owner; PLAN.md sequences the work; this
document states what an adapter **must, should, may, and must never** do, what
each shipped provider actually supports (the capability matrix), and the exact
checklist for landing provider #4. It exists so that a future session — human
or agent, on any model — can extend the provider surface without re-deriving
the architecture or violating an invariant that only lived in someone's head.

Grounded in the shipped code through 2026-08-11 (Phase P's providers plus
Phase UX's native prompt catalogs, durable resume contract, and UX.8 security closure: `claude-code`,
`codex`, `gemini-cli`, plus `mock`). File references are the source of truth
if this document and the code ever disagree — then fix this document.

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
  (Claude Code `settings.json`/CLAUDE.md/memory; Codex `~/.codex/config.toml`;
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
  top-level transcript. The client keeps in-flight work and failures visible,
  then folds only contiguous runs of a settled turn's successful tool activity
  into expandable records with the complete normalized details. A failure,
  in-flight call, batch change, or non-tool transcript row is a hard boundary,
  so compaction never changes chronology. A subagent's text/thinking
  monologue remains dropped while its **tool calls** carry `parentId`, matching
  terminals that do not interleave subagent prose into the main transcript.
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
- **I7 — Agent-neutral shared code.** `protocol.ts`, `registry.ts`,
  `permissions.ts` posture, `capOutput`, `toolDetail`, the render-tool schemas,
  and everything in `web/` must compile and behave identically with any
  adapter. If a provider needs a branch in shared code, the design is wrong —
  put the behavior in the adapter.

## 3. The `AgentSession` contract — semantics beyond the types

```ts
interface AgentSession {
  pushPrompt(text: string): void;
  onMessage(cb: (msg: WireMsg) => void): void;
  interrupt(): void;
  resolvePermission(id: string, allow: boolean): void;
  readonly resumeId?: string;
  onResumeId?(cb: (id: string) => void): void;
  refreshPromptOptions?(): void;
  close(): void;
}
```

The TypeScript interface is necessary but not sufficient. The behavioral
contract each implementation must satisfy:

**Construction** — takes `{ workspaceDir, model?, resumeId? }`. `workspaceDir`
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
turn is in flight: queue it (Claude: async-generator queue; Codex/Gemini: a
serial worker) rather than dropping or interleaving. The `!` bang transcript
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
   Every tool output passes through `capOutput()` (honest, byte-based
   truncation with `truncatedBytes` reported — never a silent cut) and every
   `tool_use.detail` through `toolDetail()` (both in `adapters/types.ts`).
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
thread.started, Gemini's first valid stream event). The registry checkpoints
that event synchronously; a later arbitrary tool/text message is not a safe
substitute.

**`refreshPromptOptions()`** — when the provider terminal has pre-submit
commands, emit one replaceable `prompt_options` catalog rather than waiting
for the user to submit a partial command. Every advertised command must be
intercepted and executed as that command on the adapter's active drive surface;
never copy a TUI/ACP catalog onto an SDK/stream-json surface that will send the
text to the model as prose. Today Claude uses SDK `supportedCommands()` plus
`commands_changed`; Codex emits its shell-reimplemented `/model` plus live
app-server `skills/list` for `$`; Gemini emits its shell-reimplemented `/model`.
Catalogs are shell metadata, not sequenced transcript history, and must fail
soft without inventing provider commands. Any provider/workspace-supplied
catalog text must carry a fixed adapter-assigned `PromptOption.source` (Claude
commands → `claude-code`; Codex skills → `codex`) so trusted prompt chrome
renders an attribution badge. Never copy a source label from provider metadata.
The registry drops an entire option containing line, direction, or invisible
display controls rather than rewriting the command value.

**`interrupt()`** — halt the in-flight turn using the provider's own mechanism
(Claude SDK `interrupt()`, Codex `AbortController`, Gemini child-process kill);
the session stays warm for the next prompt. Any pending permission requests
are denied. Must be a no-op when idle.

**`resolvePermission(id, allow)`** — completes a previously emitted
`permission_request`. Only meaningful for providers whose engine exposes an
approval callback (today: Claude Code only, via `canUseTool`); others make
this a no-op (I3). Deny is the default posture on timeout
(`PERMISSION_TIMEOUT_MS`, default 60 s), disconnect, and interrupt. An
adapter that emits `permission_request` MUST also emit `permission_resolved
{ id, allow }` for EVERY resolution path — answer, timeout, interrupt — so
every attached viewport drops its bar the moment the ask dies instead of
holding a stale prompt a tap can only no-op against (2026-07-28; funnel all
paths through one `finish`, as `claude-code.ts` does).

**`close()`** — idempotent teardown: end generators, abort turns, kill child
processes, clear timers. After `close()`, no further messages may be emitted.

## 4. Capability matrix (shipped providers, as implemented)

| Capability | `claude-code` | `codex` | `gemini-cli` | `mock` |
|---|---|---|---|---|
| Drive surface | `@anthropic-ai/claude-agent-sdk`, one warm `query()` for the session's life | `@openai/codex-sdk`, pointed at the user's installed `codex` CLI when present (SDK-bundled fallback), one warm `Thread`, `runStreamed` per turn | `gemini` CLI headless: `-p … -o stream-json`, one process **per turn** | scripted timers |
| Warm-conversation mechanism | never-ending query + async prompt queue (prompt cache preserved) | persistent `Thread` (`thread.id` resumable) | `--session-id` first turn, `--resume` after | n/a |
| Daemon-restart resume id | SDK `session_id` after init; restored with `resume` | `thread.started.thread_id`; restored with `resumeThread` | accepted UUID; restored with `--resume` (fatal id-mode self-heals) | transcript only |
| Pre-submit catalog | live SDK slash commands + `commands_changed` | implemented `/model` + `/effort` + live app-server `$` skills | implemented `/model` | scripted supported catalog |
| Text streaming granularity | token-level (`includePartialMessages`) | **buffered** — one `text_delta` per completed item (SDK emits no token deltas today) | chunked `message` events | 16-char chunks |
| Thinking stream (`thinking_delta`) | ✅ full fidelity | ✅ when reasoning items appear | ❌ observed absent → never fires (I3 proof) | ✅ scripted |
| Tool records (`tool_use`/`tool_result`) | ✅ full input, diffs | ✅ (`command_execution`, `file_change`, `mcp_tool_call`, `web_search`; only `status: "failed"` maps to `isError` — a completed command with a nonzero exit stays non-error, its exit code annotated in the output, matching the Codex TUI) | ✅ | ✅ |
| Subagent nesting (`parentId`) | ✅ (`parent_tool_use_id`) | ❌ n/a | ❌ n/a | ✅ scripted |
| Live todo checklist (`render` todo-list) | ✅ (TaskCreate/Update fold) | ✅ (`todo_list` item) | ❌ | ✅ |
| Interactive permissions (`permission_request`) | ✅ full round-trip via `canUseTool` + inherited `settings.json` | ❌ SDK exposes no approval callback → inherits user's Codex approval config (I3) | ❌ headless can't prompt → user's own tool approvals inherited; only our render server is scoped-allowed | ✅ (`dangerous` keyword) |
| Usage (`usage` msg) | ✅ tokens + cumulative `total_cost_usd` | ✅ tokens (`cached_input_tokens` is a subset of input — never re-added) | ✅ per-model token breakdown | ✅ |
| Interrupt | SDK `interrupt()` | `AbortController`; discovered-local turns also use it at the configurable eight-minute outer deadline | kill child process | clear timers |
| Render-MCP injection | **in-process** SDK MCP server (`render-tools.ts`) | subprocess stdio MCP via SDK `config.mcp_servers` (`render-mcp.ts`) | subprocess stdio MCP via **per-session `<cwd>/.gemini/settings.json`** (merged non-destructively; note: drops a file in the user's project dir) | emits `render` directly |
| Model override env | `DEFAULT_MODEL` | `CODEX_MODEL` | `GEMINI_MODEL` | — |
| Credential signal (`agentHasCredentials`) | `ANTHROPIC_API_KEY` \|\| `ANTHROPIC_AUTH_TOKEN` \|\| `ANTHROPIC_BASE_URL` | `OPENAI_API_KEY` \|\| `$CODEX_HOME/auth.json` (ChatGPT login) | `GEMINI_API_KEY` \|\| `GOOGLE_API_KEY` (Google OAuth path deprecated by Google, 2026) | none → mock is the fallback for every agent |

Known asymmetries, accepted deliberately (each is I3 at work, not debt):
Codex has no browser permission bar; Gemini has no thinking stream and pays a
process spawn per turn; Codex text arrives buffered rather than token-streamed
(revisit if the SDK grows delta events or via its app-server layer). One item
from the Codex spike remains **unverified live**: the `requestApproval` shape
(probe ran with `approval_policy:"never"`, which skips execution) — if the SDK
ever grows an approval callback, capture it before wiring `permission_request`.

**Codex executable parity (F.10, 2026-08-08):** `CodexSession` resolves the
user's installed `codex` executable (including `MIRAFOLD_CODEX_BIN`) and passes
it as the SDK's `codexPathOverride`. The SDK's bundled engine is only the
fallback when no external executable exists. Turns, `/model`, and engine-default
resolution all query that one resolved executable. This is load-bearing: two
Codex versions share `~/.codex/config.toml` and `models_cache.json`; letting a
newer terminal write those files while an older SDK engine reads them caused a
cache-schema failure, an older fallback model, and an invalid inherited
reasoning effort. Do not reintroduce separate "picker" and "engine" binaries.

**Codex discovered-local completion bound (L.4, 2026-08-11):** a real
Codex→Ollama trace proved that the former silent Tier-4 timeout was not an
adapter event-delivery stall. Ollama was pre-filling the full Codex prompt on
CPU, then Qwen was generating a long reasoning item; the SDK buffers that item
until completion. `CodexSession` therefore preserves the user's reasoning
default, exposes the Codex/Ollama-proven `none` extension only on a discovered
local endpoint, and places an eight-minute outer bound around those turns. The
bound aborts through the same `AbortController` as an interrupt and emits one
actionable error before the required single `turn_end`; configured providers
and first-party sessions receive neither override nor deadline. The deadline
is `MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS` (`0` disables it).

## 5. Generative UI: the MCP contract

The render tools (`render_card/list/table/chart/links/keyvalue/progress/timeline/filetree/question/diff`, `emit_artifact`) are
defined once — schemas in `server/registry-spec.ts` — and delivered two ways:

- **In-process** (Claude only): `server/render-tools.ts` handed to `query()`.
- **Standalone stdio process** (everything else): `server/render-mcp.ts`,
  spawned via `renderMcpCommand()` (`render-mcp-cmd.ts`) — compiled twin when
  present, `tsx` + source in dev.

Adapter obligations for either path:

1. Auto-allow **only our** render server (Claude: `mcp__ui__*` in
   `permissions.ts`; Codex: per-server `default_tools_approval_mode`; Gemini:
   `--allowed-mcp-server-names genui`). Never blanket-approve the user's other
   tools to make ours run — that's forcing a posture the terminal doesn't have.
2. Suppress the raw `tool_use`/`tool_result` rows for our render server's
   calls and emit the corresponding `render`/`artifact` WireMsg instead (the
   shared `emitGenerativeUI` path); other MCP servers' calls surface as
   ordinary tool records.
3. Re-sending a render `id` is an in-place update — adapters must preserve the
   id the MCP stub returns (Codex/Gemini extract it from the tool result text).

## 6. Adding provider #4 — the checklist

The proven sequence (used for both Codex and Gemini; keep it):

1. **Spike first** (`server/adapters/<agent>.spike.md`): identify the drive
   surface (official SDK > headless JSONL > ACP-style protocol > raw stdio, in
   order of preference), confirm it can run as its *own engine* with streamed
   events and native MCP loading, and draft the event→`WireMsg` mapping table.
   A provider that cannot load MCP servers cannot carry generative UI — that's
   a red verdict, not a workaround invitation.
2. **Capture real events live** before writing the adapter. Both spikes found
   the docs wrong in the details (Codex: dot-notation event names, buffered
   deltas; Gemini: deprecated OAuth). One throwaway probe saves a rewrite.
3. **Write the adapter** (`server/adapters/<agent>.ts`), template: `codex.ts`
   (subprocess SDK) or `gemini-cli.ts` (headless CLI). Identify the native
   durable conversation id/resume call and any pre-submit command discovery
   surface at the same time; honor every rule in §3.
4. **Wire the seam** — exactly five touchpoints, all in two files:
   - `protocol.ts`: add the name to the `AgentName` union (additive).
   - `adapters/index.ts`: `credentialKind()` case (what counts as live) and
     `backendOptions()` case (the picker's menu of ways it can run),
     `modelFor()` case (its own env var, never a shared one), `ADAPTER_AGENTS`
     entry (onboarding offers it), `createSession()` case.
5. **Verify**: `yarn typecheck`; normalization unit tests beside the mapping
   (`normalizers.test.ts` pattern); then live — one turn with text, one tool
   call rendered as `tool_use`/`tool_result`, one render component painted via
   MCP, usage in the status bar, warm turn-2 recall, interrupt mid-turn, native
   command completion before submit, and process restart followed by resume of
   the same provider conversation id. The front end and shared code should need
   **zero provider-specific changes**; if they do, stop and re-read §2.

## 7. Local models (Phase L) — the settled posture

Locked 2026-07-05, restated here because it is the standing answer to "how do
we support provider X that isn't a terminal agent":

**Local isn't a Mirafold feature; it's a property of the agent.** A
terminal agent that can point at a local OpenAI-compatible endpoint (Codex →
Ollama/vLLM/LM Studio; Claude Code → `ANTHROPIC_BASE_URL` — already counted as
"live" by `agentHasCredentials`) already runs locally, and Mirafold simply
re-skins it. **No LiteLLM, no shim, no homegrown loop for bare models.** Phase
L is documentation and ergonomics (`docs/local-models.md`, later `--local`
detection), not architecture. Small models that misfire on render tools
degrade to styled text via the Step 1.4 fallback — best-effort by design, no
curated model gate. The same logic answers future requests: if something ships
a terminal agent, it gets an adapter; if it's a bare inference endpoint, it
enters through an agent that can point at it.

## 8. Divergence log

Deviations a reviewer might flag, with why they stand:

- **Gemini writes `<cwd>/.gemini/settings.json` into the user's project.**
  Required for per-session MCP injection (Gemini merges project over global —
  the non-destructive option). Documented in README §2.2; acceptable, but any
  alternative that appears in a future Gemini version (CLI flag for an extra
  MCP server) should replace it.
- **Gemini spawns one process per turn** while Claude/Codex hold a warm
  process. Faithful to the headless surface; `--session-id`/`--resume` carries
  the conversation. ACP (`--acp`) is the noted upgrade path if stream-json
  proves limiting.
- **Codex approval round-trip is unwired** because the SDK offers no callback;
  the user's own Codex approval config governs (I2 + I3). Revisit on SDK
  updates.
- **`ANTHROPIC_BASE_URL` counts as live** with no key — deliberate, so
  proxy/local-endpoint setups don't silently fall into the mock.
