# Codex adapter — feasibility spike (P.2)

Dated 2026-07-05. Purpose: learn Codex's embedding surface before writing the
adapter, and confirm the faithful-skin pattern generalizes past Claude Code.

## Verdict: GREEN — Codex embeds exactly the way the `AgentSession` seam wants.

Codex is drivable as its **own engine** with a streamed event feed and native
MCP injection, so a Codex session can be normalized to `WireMsg` and carry
Mirafold's generative UI **without** a homegrown loop or a request-path
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
Mirafold's render server through the SDK's `config`:

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
key, then implement `server/adapters/codex/codex.ts` against the confirmed SDK event names and verify
one tool call + one render end to end.

## Registry/config wiring already in place (from P.1)

`resolveBackend()` already honors `MIRAFOLD_AGENT=codex`; `agentHasCredentials`
returns false for codex (→ mock) until this adapter lands and its OpenAI-key
check is added; `createSession()` throws a clear "no adapter yet" for codex. So
turning Codex on is: add the key check + the `codex` case, nothing structural.

## Live probe results (2026-07-05) — ground truth from the installed SDK

Ran two throwaway probes against `@openai/codex-sdk@0.142.5` live on Kyle's
**ChatGPT login** (`codex login`, free — no OpenAI API key, $0). This resolves
the spike's one open unknown: the real SDK event names/shapes. Raw capture in
`scratchpad/codex-events.txt`.

**Event names are dot-notation** (SDK projection, not the app-server's `item/…`):

```
{"type":"thread.started","thread_id":"019f347d-…"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}
{"type":"turn.completed","usage":{"input_tokens":11828,"cached_input_tokens":8960,
                                  "output_tokens":5,"reasoning_output_tokens":0}}
```

Confirmed for the adapter:
- Event `type`s seen: `thread.started` (carries `thread_id` → resume),
  `turn.started`, `item.completed` (carries `item`), `turn.completed`
  (carries `usage`). Discriminate work by `item.type` (`agent_message` seen;
  `command_execution`/`file_change`/`reasoning`/`mcp_tool_call` per the app-server
  table above — shapes still to confirm live).
- **`usage` → WireMsg**: `input_tokens` (+ `cached_input_tokens` is a subset of
  input, already counted — do NOT re-add) + `output_tokens` +
  `reasoning_output_tokens`. Map inputTokens = `input_tokens`, outputTokens =
  `output_tokens` (+ reasoning if we want parity with thinking cost).
- **Streaming granularity**: `runStreamed` emitted **buffered `item.completed`
  items, no token-level deltas** for these prompts. So v1 emits one `text_delta`
  per completed `agent_message` item (good enough); token-by-token streaming (the
  `item/agentMessage/delta` events) likely needs a config flag or the app-server
  layer — deferred, optional-feature rule covers its absence.

## P.2 integration — RESOLVED (2026-07-05, later same day)

Tooling arrived: `@openai/codex-sdk@0.142.5` + the `codex` CLI are installed,
and `~/.codex/auth.json` (ChatGPT login) is present — so live is unblocked at
$0. `server/adapters/codex/codex.ts` implemented against the confirmed SDK types
(`dist/index.d.ts`): warm `Thread`, one `runStreamed` per prompt via a serial
worker, `AbortController` for interrupt, event→`WireMsg` normalization per the
table above (agent_message→text_delta, reasoning→thinking_delta,
command_execution/file_change/mcp_tool_call/web_search→tool_use+tool_result,
todo_list→`render` checklist, turn.completed→usage+turn_end). Seam wired:
`agentHasCredentials("codex")` = OPENAI_API_KEY or `~/.codex/auth.json`;
`createSession` → `CodexSession`.

**Verified LIVE (foreground, direct adapter drive), $0 ChatGPT login:**
turn 1 → `PONG.` + `usage model=codex in=12419 out=7` + turn_end; turn 2 →
`ZEBRA-9.` + usage — **warm-thread recall of a turn-1 codename confirmed
(true)**. Behaves like Codex; no permission bar (SDK has no approval callback →
optional-feature rule). Typecheck clean.

**Bug found + fixed (Claude-ism leak):** the shared `DEFAULT_MODEL=claude-sonnet-4-6`
was being handed to Codex, which 400s ("model not supported when using Codex
with a ChatGPT account"). Fixed per inherit-don't-invent: model is now
agent-specific (`modelFor()` — `DEFAULT_MODEL` for claude, `CODEX_MODEL`/
`GEMINI_MODEL` for the others); unset → adapter passes no model → Codex inherits
its own config default. This is why usage showed `model=codex` at spike time.
*(Superseded 2026-07-16, PLAN F.7: the adapter now reads the resolved model
from Codex's own rollout record — `turn_context.payload.model` — so usage
shows the real name, e.g. `gpt-5.5`; "codex" remains only as the pre-first-turn
stand-in.)*

**Two environment constraints (both faithful/expected, neither a code defect):**
1. **Codex's bwrap sandbox can't build on this Ubuntu 24.04 box** —
   `apparmor_restrict_unprivileged_userns=1` blocks furnishing the namespace
   (uid-map, loopback) → `bwrap: loopback ... Operation not permitted`. **Kyle's
   own terminal `codex` fails identically**, so reproducing it is correct. The
   adapter sets NO sandboxMode/approvalPolicy (inherits the user's Codex
   config). Whatever makes his terminal Codex run a command makes ours run it —
   so the command-in-transcript path verifies for free then, no Mirafold
   change. (See the inherit-don't-invent memory.)
   **RESOLVED + command path now VERIFIED (2026-07-06):** Kyle relaxed the
   AppArmor restriction on his machine (`sudo sysctl -w
   kernel.apparmor_restrict_unprivileged_userns=0`). Codex's sandbox then builds,
   and the same file-creating prompt now succeeds identically in his terminal
   Codex (`exec /bin/bash -lc 'echo hello > demo-term.txt' succeeded`) and through
   the Mirafold adapter — which rendered it as a `tool_use Shell` +
   `tool_result err=false` block and wrote the file. So `command_execution`
   normalization is now observed live; P.2 is fully verified incl. command
   execution. (Un-persisted: resets to 1 on reboot unless he adds
   `/etc/sysctl.d/99-userns.conf`.)
2. ~~This harness SIGTERMs any socket-binding process that runs a Codex turn~~ —
   **RESOLVED, served-browser leg verified.** `npx tsx` under a socket-bound
   server did get SIGTERM'd, but launching the server via the **direct
   `./node_modules/.bin/tsx` binary in the harness background mode** stays alive.
   Verified live in headless Chrome (playwright-core + system Chrome) against the
   real `index.ts`: two-turn run rendered the agent reply, recalled a turn-1
   codename (warm), status bar showed `codex` + per-turn/session usage. **Stale-build
   gotcha:** the served `./dist` was a day old (pre-T2/4.2) and silently failed to
   render replies (stuck at `thinking…`) — `yarn build` fixed it. Always rebuild
   before served-mode (non-Vite) verification.

**Still to capture (cheap, next live window):** the `command_execution` item
shape and the approval round-trip. Probe 2 set `approval_policy:"never"`, which
made Codex **skip execution** (it narrated "done" but emitted no
`command_execution` item) rather than auto-run. To capture a real command
execution + `requestApproval`, use a writable sandbox with an approval policy
that actually runs/asks (e.g. `sandbox_mode:"workspace-write"` +
`approval_policy:"on-request"` or `on-failure`) — not `never`. One short live
run will lock the tool/approval mapping; the rest of the adapter can be written
offline from what's above.

## CA.1 spike — `codex app-server` as the adapter's transport (2026-08-25, codex-cli 0.149.1)

**Verdict: GREEN.** Driven by hand from a throwaway git repo with Kyle's real
`~/.codex/config.toml` (`sandbox_mode = "workspace-write"`,
`approval_policy = "on-request"`, `sandbox_workspace_write.network_access =
true`) and his ChatGPT login (plan `pro`), `-c model_reasoning_effort="low"`
for the spike only. Newline-delimited JSON-RPC over stdio, the same framing
`codex-model-list.ts` already uses. The v2 protocol schema comes from the
binary itself: `codex app-server generate-json-schema --out <dir>`.

### The surface, as observed

- `initialize` `{clientInfo}` → `{userAgent, codexHome, platformOs}`; then
  the `initialized` notification. (Already what `codex-model-list.ts` sends.)
- `thread/start` `{cwd}` → `{thread:{id,…}, model, modelProvider,
  approvalPolicy, sandbox:{type:"workspaceWrite", writableRoots, networkAccess,
  …}, approvalsReviewer:"user", instructionSources:["~/.codex/AGENTS.md"]}`.
  Optional params of note: `sandbox`, `approvalPolicy`, `model`,
  `modelProvider`, `config` (the same dotted overrides as `-c`),
  **`developerInstructions`**, `baseInstructions`, `ephemeral`.
- `turn/start` `{threadId, input:[{type:"text", text}]}` → `{turn:{id,…}}`;
  then notifications `turn/started`, `item/started` / `item/completed`
  (item `type`: `userMessage`, `reasoning`, `agentMessage`,
  `commandExecution` with `command`, `cwd`, `status`, `exitCode`,
  `aggregatedOutput`; `fileChange`), deltas `item/agentMessage/delta`,
  `item/reasoning/*Delta`, `item/commandExecution/outputDelta`,
  `turn/diff/updated`, `thread/tokenUsage/updated`, `account/rateLimits/updated`,
  `thread/status/changed` (`active` with `activeFlags:["waitingOnApproval"]`
  while a request is pending; `idle` after), and `turn/completed`
  `{turn:{status:"completed"|"interrupted"|"failed"}}`.
- **Approvals are server→client JSON-RPC requests**, answered by a response
  with the same `id`: `item/commandExecution/requestApproval`
  `{threadId, turnId, itemId, command, cwd, reason, commandActions,
  networkApprovalContext?}` → `{decision:"accept"|"acceptForSession"|
  "decline"|"cancel"|…}`; also `item/fileChange/requestApproval` and
  `item/permissions/requestApproval` (schema-known, not exercised).
  `serverRequest/resolved` follows the answer.
- `thread/resume` `{threadId, cwd}` → the same shape as `thread/start` plus the
  prior turns; `turn/interrupt` `{threadId, turnId}` → `{}` and the turn ends
  `"interrupted"`.

### What was observed, probe by probe

| probe | app-server (Kyle's config) | `codex exec` (Mirafold today) |
|---|---|---|
| append + `git commit` in the workspace | ran, **no approval asked**, commit landed | ran, commit landed |
| write to `$HOME/…` (outside the writable roots) | `item/commandExecution/requestApproval`, `reason: "Allow the exact command you requested to create /home/…?"`; **declined → status `declined`, agent says permission was denied**; the file was never created | command fails inside the sandbox: `zsh:1: read-only file system: /home/…` — **nobody can be asked**, the agent just reports the error |
| `curl https://example.com` with `network_access=false` | first run fails inside the sandbox (`Could not resolve host`), Codex **asks** (`reason: "…outside the network-restricted sandbox?"`); **accepted → re-ran outside the sandbox and succeeded** | (not run; same mechanism as the row above) |
| `thread/resume` in a fresh process | works — the model recalled the earlier commit | n/a (`resume` is `exec resume <id>`) |
| `developerInstructions` on `thread/start` | **honored** ("PINEAPPLE. Hello!") — a real system-level hook, unlike `exec` | none (guidance rides the first user turn) |
| `turn/interrupt` mid-`sleep 60` | `turn/completed` `"interrupted"` in ~1 s | SDK abort signal |
| MCP + provider via `-c` | rides along as with `exec` (proved by `-c sandbox_workspace_write.network_access=false`) | same |

So: **the "read-only" Kyle hit is the `exec` failure mode.** `codex exec` is
Codex's non-interactive entry point; a sandbox denial there is just an error
string (`read-only file system`) the model works around. On `app-server` the
same denial becomes a question with a human-readable `reason` — the terminal's
"retry outside the sandbox?" — and the answer decides. `.git` itself is NOT
read-only in 0.149.1 under either path (the binary carries no such rule; the
commit succeeded twice); the wording came from a denial elsewhere.

### The one trust finding (both paths, pre-existing)

Codex **writes `[projects."<cwd>"] trust_level = "trusted"` into
`~/.codex/config.toml` on every headless start** — `exec` (Mirafold today),
`thread/start`, even `thread/start` with `ephemeral: true`, with no turn sent.
The terminal TUI asks "trust this folder?" first; headless Codex does not.
This is Codex's own write into the user's own Codex config, identical to what
Mirafold's current path already causes, so CA does not worsen it — but the
faithful-skin bar says the user should be *asked* the way the TUI asks.
**CA.3 owns this:** before the first `thread/start` in a folder Codex has not
recorded, Mirafold asks its own shell-owned trust question (the
`workspace-trust.ts` mechanism Gemini uses) and starts the thread only on yes.
(Four scratch entries from this spike are in Kyle's config — lines named in
the report; his file, his deletion.)

### Consequences for CA.2–CA.4

- Transport: a long-lived `codex app-server` per session (the one-shot
  `jsonrpc-oneshot.ts` framing, made persistent), `thread/start` /
  `thread/resume` with `cwd`, `turn/start` per prompt, `turn/interrupt` for
  stop. `sandbox` / `approvalPolicy` stay UNSET (inherited from config —
  faithful, as today). Resume id = the thread id.
- `@openai/codex-sdk` has no remaining role once the transport lands → remove
  (dependency policy: zero passengers).
- Approvals: `item/commandExecution/requestApproval` → `permission_request`
  (tool "Shell", detail = `command`, the engine's `reason` badged with
  `source` on the notice line); the bar's answer → `{decision:"accept"}` /
  `{decision:"decline"}`; `item/fileChange/requestApproval` the same with tool
  "apply_patch"; `item/permissions/requestApproval` answered with the granted
  profile (map to one allow/deny for the first cut). `thread/status/changed`
  `waitingOnApproval` is the needs-you signal.
- `developerInstructions` becomes RENDER_GUIDANCE's home for Codex — no more
  first-turn prepend, and the CX.1 paragraph reaches Codex the way it reaches
  Claude.
- Event mapping: `item/*` replaces the exec-JSON `item.*` shapes the mapper
  knows; `agentMessage` deltas stream, `commandExecution` carries
  `aggregatedOutput` + `exitCode` on completion (same fields, camelCase).
- Not exercised, noted: `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`, `acceptForSession`, the network-policy
  amendment decisions, `thread/fork`, `turn/steer`. None gates CA.2.

Driver + raw JSONL logs: the session scratchpad (`spike-driver.mjs`,
`spike-*.jsonl`) — throwaway, not committed.
