# Codex adapter — feasibility spike (P.2)

Dated 2026-07-05. Purpose: learn Codex's embedding surface before writing the
adapter, and confirm the faithful-skin pattern generalizes past Claude Code.

## Verdict: GREEN — Codex embeds exactly the way the `AgentSession` seam wants.

Codex is drivable as its **own engine** with a streamed event feed and native
MCP injection, so a Codex session can be normalized to `WireMsg` and carry
genui-shell's generative UI **without** a homegrown loop or a request-path
proxy. No shared code needs a Codex-specific branch; it's one adapter behind
`createSession()`, same as `claude-code`.

## The surface we drive

**Official TypeScript SDK — `@openai/codex-sdk`** (Node 18+). The direct analog
of `@anthropic-ai/claude-agent-sdk`: it spawns the `codex` CLI and exchanges
JSONL events over stdio.

```ts
import { Codex } from "@openai/codex-sdk";
const codex = new Codex({ /* env, config, baseUrl */ });
const thread = codex.startThread({ workingDirectory, skipGitRepoCheck });
const { events } = await thread.runStreamed(prompt); // async generator
for await (const ev of events) { /* normalize → WireMsg */ }
// thread.id persists a conversation; codex.resumeThread(id) re-attaches.
```

- `run()` buffers a turn; `runStreamed()` yields structured events live — we use
  the streamed form (mirrors how the Claude adapter reads `query()`).
- Config passes through as CLI `--config` dotted overrides: the SDK takes a
  nested JSON object, flattens to dotted paths, serializes TOML literals. So
  every `~/.codex/config.toml` key is reachable from `config: {...}`.

Below the SDK sits the **app-server** (JSON-RPC 2.0, the protocol powering the
VS Code extension / desktop / remote TUI). The SDK is the higher, cleaner
surface; drop to the app-server only if the SDK hides something we need.

## Event → WireMsg mapping (the normalization the adapter implements)

| Codex stream event                     | WireMsg                                            |
|----------------------------------------|----------------------------------------------------|
| `turn/started`                         | `status:thinking`                                  |
| `item/agentMessage/delta`              | `text_delta`                                       |
| `item/agentReasoning/delta`            | `thinking_delta` (+ `status:thinking` on start)    |
| `item/commandExecution/started`        | `status:tool` + `tool_use` (Bash; detail=command)  |
| `item/commandExecution/delta` (base64) | buffer stdout/stderr → folds into the result       |
| `item/commandExecution/completed`      | `tool_result` (via `capOutput`, honest truncation) |
| `item/fileChange/*`                    | `tool_use`/`tool_result` (Edit/Write; diff=input)  |
| `item/toolCall/*` (MCP tools)          | our render tools paint their own block (skip, like `mcp__ui__`); other MCP tools → `tool_use`/`tool_result` |
| `item/commandExecution/requestApproval`| `permission_request` → answer w/ `permission_response` |
| `item/fileChange/requestApproval`      | `permission_request` → `permission_response`       |
| `turn/completed` (`inputTokens`/`outputTokens`/`totalTokens`) | `usage` + `turn_end`         |

The SDK projects these as `item.completed` (with a discriminated `event.item`:
`command_execution` | `agent_message` | `mcp_tool_call` | `file_change` |
`reasoning`) plus `turn.completed` (`event.usage`), and the finer `*/delta`
events for live streaming. **Confirm the exact SDK event enum names against the
installed package** before finalizing the adapter — this table is from the
app-server protocol; the SDK's names may differ slightly (`item.completed`
vs `item/completed`).

Every target WireMsg already exists (Phase 0/T/T2) — no protocol change needed,
honoring the "ADD, never reshape" non-negotiable. Optional-feature rule applies:
if a Codex build doesn't emit reasoning, `thinking_delta` simply never fires.

## The core requirement — generative UI via MCP — is satisfied

Codex natively loads MCP servers (`mcp_servers` in config.toml). Inject
genui-shell's render server through the SDK's `config`:

```ts
new Codex({ config: { mcp_servers: { genui_ui: {
  command: "node", args: [/* our stdio MCP entry */] } } } });
```

Caveat vs. the Claude adapter: `makeRenderServer` today is an **in-process** SDK
MCP server (a JS object handed to `query()`). Codex loads MCP servers as
**subprocesses over stdio/HTTP**. So P.3 needs the render tools packaged as a
standalone stdio MCP process (or an HTTP MCP endpoint the daemon already hosts)
that emits `render`/`artifact` WireMsgs back to the session. This is a
mechanical repackage of `render-tools.ts`, not a redesign — flagged for P.3.

## Config we set per session (faithful, agent-scoped)

- `model` — from the `Backend.model` config.
- `workingDirectory` — the session cwd (same role as the Claude adapter's `cwd`).
- `approval_policy` / `sandbox_mode` — set so command/patch approvals surface as
  `requestApproval` (→ our browser permission bar) instead of auto-running or
  hard-blocking. Codex's own approval semantics, faithfully surfaced — no Claude
  `canUseTool` reuse.
- Auth: `OPENAI_API_KEY` in env (SDK injects `CODEX_API_KEY`), or `codex login`
  (ChatGPT subscription). Secret stays server-side, never on the wire.

## Blocking dependencies for the *live* Done-when (not present in this env)

P.2's Done-when — "a Codex session runs live from an OpenAI key" — needs all of:

1. `npm i @openai/codex-sdk` (not yet a dependency).
2. The `codex` CLI binary installed and on PATH (the SDK spawns it). Absent here.
3. An OpenAI API key **or** a ChatGPT login for Codex. Absent here.

None are available in this environment, so the live run is blocked on
credentials/tooling only Kyle can provide — the pattern itself is proven
feasible above. Next actions gated on that: install the SDK + CLI, provision the
key, then implement `codex.ts` against the confirmed SDK event names and verify
one tool call + one render end to end.

## Registry/config wiring already in place (from P.1)

`resolveBackend()` already honors `GENUI_AGENT=codex`; `agentHasCredentials`
returns false for codex (→ mock) until this adapter lands and its OpenAI-key
check is added; `createSession()` throws a clear "no adapter yet" for codex. So
turning Codex on is: add the key check + the `codex` case, nothing structural.
