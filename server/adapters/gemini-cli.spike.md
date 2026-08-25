# Gemini CLI adapter — feasibility spike (P.5)

Dated 2026-07-06. Purpose: confirm the faithful-skin seam generalizes to a THIRD
agent (Google's Gemini CLI) before writing the adapter, and prove the
optional-feature rule (capabilities an agent lacks simply don't appear).

## Verdict: GREEN — Gemini CLI embeds the same way the `AgentSession` seam wants.

Like Codex, Gemini CLI is drivable as its **own engine** with a streamed JSONL
event feed and native MCP injection, so a Gemini session normalizes to `WireMsg`
and carries Mirafold's generative UI **without** a homegrown loop or a
request-path proxy. One adapter behind `createSession()`, same as `claude-code`
and `codex`. No shared code needs a Gemini branch.

Installed live for the spike: `@google/gemini-cli` **v0.49.0** (`npm i -g`, free,
no login needed to inspect the surface). CLI flags below are from `gemini --help`
on that version; event field shapes are to be **captured live** (see Open
questions) — exactly the discipline that worked for Codex.

## The surface we drive

**The `gemini` CLI in headless mode** (no official Node SDK like Codex's; the
headless stream-json interface IS the programmatic surface — we spawn the binary
and parse stdout, the way the Codex SDK spawns `codex` under the hood).

Drive one turn:
```
gemini -p "<prompt>" -o stream-json -m <model> --session-id <uuid> [--resume latest]
```
- `-p/--prompt` → non-interactive (headless). `-i/--prompt-interactive` runs a
  prompt then stays interactive (not what we want).
- `-o/--output-format stream-json` → **JSONL events** (real-time newline-delimited
  JSON), the format built for "building UIs with live progress." (`text` and
  `json` are the other two; we use stream-json, mirroring Codex JSONL.)
- `-m/--model` → the model (faithful: from `Backend.model` if set, else Gemini's
  own default — inherit, don't invent).

**Warm multi-turn** (Codex had a persistent `Thread`; Gemini has sessions):
`--session-id <uuid>` starts a session with our id; `-r/--resume latest|<index>`
resumes it, and `--session-file <json>` / `--list-sessions` / `--delete-session`
manage them. So the adapter keeps one session id for the object's life and
resumes it each turn — warm conversation, same role as the Codex thread.

Alternative surface noted for later: `--acp` starts the agent in **ACP** (Agent
Client Protocol, the structured protocol Zed etc. use to drive it) — a cleaner
bidirectional interface than parsing stdout if stream-json proves limiting. Keep
stream-json for v1; ACP is the upgrade path.

## Event → WireMsg mapping (the normalization the adapter implements)

Stream-json emits these JSONL event `type`s (from the headless docs):

| Gemini JSONL event | WireMsg                                              |
|--------------------|------------------------------------------------------|
| `init`             | session metadata (session id, model) → `status`/model label |
| `message`          | assistant text chunk → `text_delta` (user chunks ignored) |
| `tool_use`         | `tool_use` (name + args = input; detail = salient arg) |
| `tool_result`      | `tool_result` (via `capOutput`, honest truncation)   |
| `error`            | `error` (non-fatal warnings + system errors)          |
| `result`           | `usage` (per-model token breakdown) + `turn_end`      |

Every target `WireMsg` already exists — no protocol change (honors ADD-never-
reshape). Our render MCP tool calls arrive as `tool_use`/`tool_result` for the
`genui` server and are folded into `render`/`artifact` WireMsgs by the SAME
`emitGenerativeUI` path the Codex adapter uses (server-name match + suppress raw
rows). Optional-feature rule: if Gemini emits no reasoning stream, `thinking_delta`
simply never fires — nothing special-cased. **This is the P.5 degradation proof.**

## Generative UI via MCP — satisfied

Gemini CLI natively loads MCP servers (`mcpServers` in settings.json). Inject the
same standalone stdio render server (`server/render-mcp.ts`, built in P.3) via a
**per-session `.gemini/settings.json`** written into the session cwd (Gemini
merges project settings over global — so we ADD our server without touching the
user's own `~/.gemini/settings.json`, faithful):
```jsonc
// <session cwd>/.gemini/settings.json
{ "mcpServers": { "genui": { "command": "<tsx>", "args": ["<render-mcp.ts>"] } } }
```
Tool approval (headless can't prompt — same wall as Codex exec): allow our server
specifically via `--allowed-mcp-server-names genui`, and/or a per-server `trust`
in the settings block, rather than the blunt `--yolo`/`--approval-mode yolo`
(which would also auto-approve the user's shell — not ours to force). Exact
knob TBD live (see Open questions), but a scoped allow exists — same posture as
Codex's per-server `default_tools_approval_mode: "approve"`.

## Config we set per session (faithful, agent-scoped)

- `model` — from `Backend.model` (`GEMINI_MODEL`), else Gemini's own default.
- session cwd — `--session-id` + the `.gemini/settings.json` live here.
- sandbox/approval for the USER's tools — inherited from the user's Gemini config,
  NOT forced (inherit-don't-invent). Only our `genui` MCP server is auto-allowed.
- Auth: free **Google-account OAuth** (`gemini` → "Login with Google"), or
  `GEMINI_API_KEY`. Secret stays server-side, never on the wire.

## Seam wiring needed (small, mirrors Codex P.2/P.4)

- `agentHasCredentials("gemini-cli")`: true if `GEMINI_API_KEY` or a Google OAuth
  login exists (`~/.gemini/oauth_creds.json` or equivalent — confirm path live).
- `createSession` gains a `gemini-cli` case → `GeminiCliSession`.
- add `gemini-cli` to `ADAPTER_AGENTS` so agent picker (P.4) offers it.
- `modelFor("gemini-cli")` already returns `GEMINI_MODEL` (P.2).

## Blocking dependency for the *live* Done-when (Kyle-only, free)

The live run needs a **Google-account login** for the Gemini CLI — free tier, no
API key, no billing (personal Google account: generous daily limits). One-time
interactive OAuth (browser), like `codex login`. The CLI is already installed.

## Open questions to resolve in the first live window (cheap)

1. **Exact JSONL field names** per event (`message` content field; `tool_use`
   name/args fields; `result` usage/token fields). Capture with one live
   `gemini -p "hi" -o stream-json` and read the raw JSONL (as the Codex probe did).
2. **Warm-session mechanics**: confirm `--session-id` + `--resume` continues the
   conversation across separate headless invocations (vs. needing one long-lived
   `--acp`/interactive process).
3. **Scoped MCP approval** in headless: confirm `--allowed-mcp-server-names genui`
   (and/or per-server `trust`) makes our render tools run without a prompt, while
   leaving the user's own tool approvals inherited.
4. **OAuth creds path** for the `agentHasCredentials` check.

One short live session answers all four; the adapter is then a mechanical write
against the confirmed shapes (the Codex adapter is the template).
