# OpenCode adapter — feasibility spike

Dated 2026-08-13. Purpose: learn OpenCode's embedding surface before writing a
fourth adapter, and settle the questions that decide whether it fits the
`AgentSession` seam: drivability, MCP injection without touching user-owned
files, permission bridging, and how the provider credential policy applies to
a multi-provider harness. Sources: opencode.ai docs (server, config, mcp,
providers, permissions, agents, commands), the published
`@opencode-ai/sdk@1.18.18` generated types (fetched via jsDelivr), and
anomalyco/opencode issue #20072. **No live probe ran** — the binary isn't
installed in this environment — so every "confirm live" flag below is real.

## Verdict: GREEN, with two live-verify gates before implementation starts

OpenCode is drivable as its **own engine** — arguably the cleanest surface of
the four: a headless HTTP server (`opencode serve`) with an OpenAPI 3.1 spec,
a typed SSE event stream, native MCP loading, and (unlike the Codex SDK at
spike time) a **first-class permission round-trip over the API**. Sessions are
persistent server-side objects with stable ids (→ `resumeId` for free). No
homegrown loop, no request-path proxy, no shared-code branches.

The two gates that MUST be confirmed live before `opencode.ts` is written:

1. **MCP injection via `OPENCODE_CONFIG_CONTENT` actually loads our render
   server** (§MCP below — the merge is documented, but issue #20072 shows
   inline config had at least one quirk in the `mcp` key's handling).
2. **The permission ask actually surfaces as a `permission.updated` event
   when driven over the server API** (docs describe the TUI; the types and
   reply endpoint exist, but the headless flow is undocumented).

## The surface we drive

`opencode serve [--port N] [--hostname H]` — headless HTTP server, default
`127.0.0.1:4096`. The adapter spawns one per session (or one shared, decided
at implementation) via the standard `agentBin("OPENCODE_BIN", "opencode")`
lookup, picks a free port itself (port-0 auto-assign unconfirmed), and sets
`OPENCODE_SERVER_PASSWORD` to a per-session random secret — the port is
localhost-bound but otherwise open to any local process, and basic auth is
built in, so use it.

Endpoints (from the docs + generated SDK client):

- `POST /session` — create; response carries the session `id`.
- `POST /session/:id/prompt_async` — send a prompt without blocking (the
  sync `POST /session/:id/message` waits for the whole turn; we stream, so
  async + events is our shape).
- `POST /session/:id/abort` — halt the in-flight turn → `interrupt()`.
- `POST /session/:id/permissions/:permissionID` — answer a permission ask.
- `GET /event` — SSE stream of typed events (below).
- `GET /doc` — OpenAPI 3.1 spec; `GET /global/health` — liveness + version.
- Provider/model/agent/command catalogs are queryable (the SDK exposes
  them; exact endpoint paths to read off `GET /doc` live).

Prompt body (from the generated types): `parts` (text/file/agent/subtask
inputs), optional `model: { providerID, modelID }`, optional `agent`
(build/plan/custom), optional `system`, per-call `tools` enable/disable map.
Model and agent are **per-prompt**, which makes the fleet-row model label and
a faithful build/plan toggle straightforward.

## Event → WireMsg mapping (the normalization the adapter implements)

The SSE event union is large (31 types); the ones we consume:

| OpenCode event                              | WireMsg                                             |
|---------------------------------------------|-----------------------------------------------------|
| `session.status`                            | `status:thinking` (turn activity)                   |
| `message.part.updated`, part `step-start`   | `status:thinking`                                   |
| `message.part.updated`, part `text`         | `text_delta` (parts arrive as growing snapshots — emit the suffix vs. what we already sent, same accrual trick as the Gemini adapter) |
| `message.part.updated`, part `reasoning`    | `thinking_delta`                                    |
| `message.part.updated`, tool `pending`/`running` | `status:tool` + `tool_use` (detail via `toolDetail`) |
| `message.part.updated`, tool `completed`    | `tool_result` (`capOutput`; `title` is a bonus label) |
| `message.part.updated`, tool `error`        | `tool_result` err=true (`error` text)               |
| tool part where tool ∈ mirafold MCP         | skip the tool block; paint via `generativeUIMsg`    |
| `todo.updated`                              | `render` checklist (`TodoItem` shape matches)       |
| `permission.updated`                        | `permission_request` → answered via the reply endpoint |
| `message.updated` (assistant msg, token/cost fields) | `usage` (field names to confirm live)      |
| `session.idle`                              | `turn_end`                                          |
| `session.error`                             | error notice — engine text, so `notice.source` badges it (shell-voice rule) |

Not consumed (TUI/PTY/LSP/VCS chrome): `tui.*`, `pty.*`, `lsp.*`,
`vcs.branch.updated`, `file.watcher.updated`, `installation.*`,
`server.*`, `session.compacted`/`diff`/`created`/`updated`/`deleted`,
`message.removed`, `message.part.removed`, `permission.replied`,
`command.executed`, `file.edited` (the tool parts already carry edits).

Every target WireMsg already exists — no protocol change beyond adding
`"opencode"` to the `AgentName` union (additive; honors ADD-never-reshape).

## Generative UI via MCP — satisfied, via env-var config injection

OpenCode loads MCP servers from its config under the `mcp` key
(`{"type": "local", "command": [...]}` — subprocess over stdio, exactly what
`renderMcpCommand()` already packages for Codex and Gemini). The injection
path that keeps the trust rule intact is **`OPENCODE_CONFIG_CONTENT`**:
inline JSON config passed in the spawned server's environment, merged
additively into the user's config chain (documented merge order puts it
after global and project files; merge combines keys rather than replacing).
**No file the user owns is read differently, written, or created** — the
`.gemini/settings.json` failure mode structurally can't recur here.

Caveats, both live-verify items:

- Issue #20072 (closed "not planned") shows `OPENCODE_CONFIG_CONTENT` failing
  to apply `enabled: false` to MCP entries. Our use is additive (a new server,
  not disabling one), which is the documented merge behavior — but that issue
  is proof the inline path has had sharp edges in exactly the `mcp` key.
  Gate 1: verify our entry loads and its tools appear.
- The user's own configured MCP servers also load at startup (same issue —
  there is deliberately no way to suppress them). That's fidelity, not a bug:
  their agent, their tools. Their tool calls normalize as ordinary
  `tool_use`/`tool_result`.
- How OpenCode names MCP tools in tool parts (`mirafold_render_card` vs a
  server-qualified form) decides the recognition test against
  `MIRAFOLD_MCP` — confirm the exact prefix live.

## Permissions — a real API round-trip (better than the Codex SDK had)

OpenCode's permission system (`allow`/`ask`/`deny`, per-tool with glob
patterns, config-set) emits a `Permission` object: `{ id, type, pattern?,
sessionID, messageID, callID?, title, metadata, time }` — and the reply is
`POST /session/:id/permissions/:permissionID` with response
`"once" | "always" | "reject"`.

- Map `permission_request` ← `permission.updated`; `resolvePermission(id,
  allow)` → `once` / `reject`. **Never send `"always"`** — it persists an
  approval into the user's own OpenCode state, which is theirs to grant in
  their own tool, not ours to write through a browser click.
- `PERMISSION_TIMEOUT_MS` deny-by-default applies unchanged.
- We set no permission config of our own: the user's `allow/ask/deny` rules
  ride along untouched (inherit-don't-invent). Whatever asks in their
  terminal OpenCode asks in Mirafold.
- Gate 2: confirm the ask actually fires headless (not just in the TUI) and
  that `abort` cleanly cancels a pending ask.

## Credential policy — the adapter's real design work

OpenCode is a multi-provider harness: 75+ providers, credentials in
`~/.local/share/opencode/auth.json` via `opencode auth login` (`/connect`),
typed `oauth` (subscription OAuth: **Anthropic Claude Pro/Max, OpenAI
ChatGPT, GitHub Copilot, GitLab Duo**, …) or `api` (keys), plus env-var
credential chains (Bedrock, Vertex). So `CredentialKind` is no longer a
per-agent fact — it's a fact about the **provider the session's model
resolves to**:

- anthropic + `oauth` → `subscription` → **blocked** (written prohibition;
  driving it through OpenCode instead of the Claude binary changes nothing).
- google + `oauth` → `subscription` → **blocked** (same).
- openai + `oauth` (ChatGPT) → `subscription` → the **disclosed gray area**,
  same disclosure copy contract as the codex adapter's CONNECT_HINT.
- any provider + `api` key / env chain → `api-key` → allowed; relay-eligible.
- local providers (Ollama, LM Studio) → `local` → anything goes.
- **any other provider + `oauth`** (Copilot, GitLab Duo, future ones) →
  treated as `subscription` and **blocked until classified** — the same
  fail-closed default `allowedOverRelay` uses for unknown kinds. Each gets a
  cited row in `provider-policy.ts` only when its terms have actually been
  read (Copilot is the one users will hit first; research it before launch
  of this adapter, not after a complaint).

Mechanically: `provider-policy.ts` grows a provider-id–keyed classification
for OpenCode-backed sessions (the one-file rule holds — the matrix stays
there, the adapter only calls it). `Backend.provider` (added for Codex)
already carries the chosen provider id. Detection order: prefer asking the
**running server** (the provider catalog reports each provider's source and
models; the SDK's `Auth` type distinguishes `oauth`/`api`) over reading
`auth.json` ourselves — the file is user-owned state, and the API tells us
what we need without us parsing their credential store. Confirm live that
the provider catalog actually exposes enough to classify without touching
`auth.json`; if it doesn't, reading that file needs the same explicit
consent framing as any user-owned state (trust rule), or we ask the user to
pick the provider at onboarding and verify against the catalog.

The relay gate is untouched: `allowedOverRelay` already refuses
`subscription` regardless of which adapter produced it.

## Faithful-skin surface (what an OpenCode user expects to see)

- **Agents**: `build` (default) and `plan` primaries, custom agents from
  their config; selected per-prompt via the `agent` field. Mirafold surfaces
  the same toggle (their Tab-cycle, our UI) — catalog queryable from the
  server.
- **Commands**: built-ins (`/init`, `/undo`, `/redo`, `/share`, `/help`) +
  custom commands from their files; feed `emitPromptOptions` if the catalog
  is exposed over the API (SDK suggests yes — confirm; if not, the
  optional-feature rule covers absence).
- **Models**: the provider catalog drives a real cross-provider model picker
  (their whitelist/blacklist config already applied server-side).
  `modelName` = the per-prompt `modelID`, known at selection — better than
  the mid-stream refinement the other adapters need.
- **Subagents** (`@general`, `@explore`, `@scout`): their invocations arrive
  as `subtask`/`agent` parts — v1 renders them as ordinary transcript
  activity; child-session navigation is TUI chrome we don't reproduce.

## SDK vs raw HTTP — recommendation: take `@opencode-ai/sdk`

The dependency test, run explicitly: this is a **vendor's own SDK** (the
"take it" case), and the sliver argument cuts the other way here — the value
isn't the fetch wrapper (self-writable in an afternoon), it's the
**generated types for a 31-variant event union and every request body**,
regenerated against each server release. OpenCode ships new versions near
daily; typed drift detection at compile time is accumulated hardening we
shouldn't hand-roll. Costs, named: one runtime dependency (`@opencode-ai/sdk`,
a generated fetch client; transitive tree to be checked at install — expect
small, but verify), tracked against a fast-moving 1.x. Fallback if the tree
turns out ugly: the raw surface is fully documented (OpenAPI + SSE), so
dropping the SDK later is mechanical, like `jsonrpc-oneshot` for Codex.
Note: use `createOpencodeClient` against a server **we** spawn (for env
control: `OPENCODE_CONFIG_CONTENT`, password, port) — not `createOpencode`,
which spawns its own.

## Blocking dependencies for the live Done-when (absent in this env)

1. The `opencode` binary (install: `curl -fsSL https://opencode.ai/install |
   bash`, or `npm i -g opencode-ai`). Not installed here (checked-for but
   the probe was declined; treat as absent).
2. A connected provider. **$0 paths exist**: a local Ollama model (kind
   `local`, no ToS concern — also the cleanest way to exercise Gate 1 and 2),
   or an existing API key. A subscription OAuth login is NOT needed for the
   live spike and shouldn't be used for it.
3. `@opencode-ai/sdk` as a dependency (decision above, confirmed at
   implementation).

## Wiring notes (the P.1-pattern checklist)

- `AgentName` union + adapter registry (`index.ts` `createSession`),
  `agentHasCredentials("opencode")` = binary present ∧ ≥1 usable provider.
- Onboarding card + agents-meta entry (connect hint carries the gray-area
  disclosure only when the chosen provider needs it).
- Policy rows in `provider-policy.ts` per the section above.
- Tests mock-first in all three tiers (fake SSE feed for Tier 1, real spawned
  server with a mock provider if feasible for Tier 2); live last.
- MIRAFOLD_MCP recognition per the confirmed tool-name prefix.

Next actions, gated on Kyle: install the binary + connect a $0 provider,
run the two live gates, lock the event/tool shapes, then phase the adapter
into PLAN.md. The rest of the adapter can be written offline from the above.

## Live probe results (2026-08-13) — both gates GREEN, $0, no credentials

Ran `opencode-ai@1.18.18` scratchpad-local (npm install + manual
postinstall; no global mutation), `HOME`/XDG jailed to the scratchpad so no
user-owned file was read or written. Gate 2 needed no real provider: a
**fake OpenAI-compatible endpoint** registered via config
(`provider.fake = {npm: "@ai-sdk/openai-compatible", options.baseURL →
localhost}`) scripted a bash tool call, which also logs the request body —
revealing the full tool list the engine advertises. Raw captures in
`scratchpad/oc-probe/` (events.ndjson, requests.ndjson, messages.json).

**Gate 1 — MCP injection: PASSED.** `OPENCODE_CONFIG_CONTENT` alone loaded
the render server: `GET /mcp` → `{"mirafold":{"status":"connected"}}`, and
the model was offered all 18 tools named
**`mirafold_render_card` … `mirafold_emit_artifact`** — underscore-joined
`<server>_<tool>`, so recognition = `startsWith(MIRAFOLD_MCP + "_")`.
The #20072 worry doesn't apply to additive entries.

**Gate 2 — headless permissions: PASSED.** With `permission: {bash: "ask"}`
the engine paused the tool (`status: running`) and emitted
**`permission.asked`** — NOT `permission.updated` as the published SDK
types said (real drift; trust live capture and pin the SDK version).
Payload: `{id, sessionID, permission: "bash", patterns: ["echo
mirafold-probe"], metadata: {command}, always: ["echo *"], tool:
{messageID, callID}}`. Reply `POST /session/:id/permissions/:permID
{response: "once"}` → `true` → bash executed and the turn completed
(`permission.replied` observed). The `always` field is the engine
suggesting a persistent rule — reinforces the never-send-`always` call.

**Shapes locked for OC.1:**

- **Streaming**: text arrives via **`message.part.delta`**
  `{sessionID, messageID, partID, field: "text", delta}` — a true delta
  channel (no accrual-diff needed); `message.part.updated` carries part
  snapshots (tool state transitions land here). Turn end: `session.idle`.
- **Usage**: per assistant message (`message.updated` / `GET
  /session/:id/message`): `tokens: {total, input, output, reasoning,
  cache: {read, write}}`, `cost`, and **`modelID` on every assistant
  message** (fleet-row label solved).
- **Event names beyond the fetched types** (1.18.18 live):
  `permission.asked`, `permission.replied`, `message.part.delta`,
  `session.diff`, `plugin.added`, `catalog.updated`, `server.heartbeat`.
- **Catalogs**: `GET /agent` (primaries incl. internal ones — filter
  `build`/`plan`-style user-facing from `compaction`/`summary`/`title`),
  `GET /command` (`init`, `review`, `customize-opencode` built-in; feeds
  `emitPromptOptions`), `GET /config/providers`, `GET /provider/auth`.

**Two findings that reshape OC.3 slightly:**

1. **1.18.18 offers NO Anthropic or Google OAuth** (`GET /provider/auth`
   lists oauth for openai, github-copilot, gitlab, poe, digitalocean,
   snowflake-cortex, xai only — presumably dropped after Anthropic's
   April 2026 harness block). Our blocked rows stay (fail-closed, and
   older/newer versions may differ) but the common path is unblocked.
2. **A fresh install ships a working free provider**: "OpenCode Zen"
   (`id: opencode`, `options.apiKey: "public"`, free models e.g.
   `laguna-s-2.1-free`). So `agentHasCredentials("opencode")` can be true
   out of the box — and the Zen provider needs its own policy row (their
   own gateway, their terms; classify before OC.3 ships, fail-closed
   until read).

**Still open for OC.0's checkbox** (needs a real connected credential,
i.e. Kyle): whether a *stored* credential's kind (oauth vs api) is
readable from the running server for the OC.3 detection path — the jailed
home had none to observe. Everything else in OC.0 is resolved.
