# Mirafold

A **faithful browser re-skin of terminal coding agents**. Mirafold puts a
browser dashboard — with generative UI on top — onto whichever terminal agent
you already use — **Claude Code, Codex, or Gemini CLI** — staying faithful
to that agent: a Codex user gets **Codex** in the browser, never "Claude
things". A full agentic engine — filesystem, bash, tools, a warm persistent
session — runs behind a web front end, and the agent's output stream is treated
as a **UI-instruction stream**: it paints streamed markdown and live registry components into an
output zone, those components can act back through a server-mediated action
bridge, and — when no component fits — the agent emits sandboxed arbitrary UI
into a locked-down iframe. A fixed, trusted shell owns the prompt box, the
socket, and all credentials, and the agent can never touch any of them.

> **The faithful-skin-per-agent model is the identity, and it's shipped (PLAN
> Phase P, complete).** Three terminal agents run behind one front end today —
> **Claude Code** (Anthropic Agent SDK), **Codex** (OpenAI), and **Gemini CLI**
> (Google) — each driving its **own** engine, normalizing its event stream to
> `WireMsg` behind the `AgentSession` seam (§2.2), and carrying Mirafold's
> generative UI via **MCP**. A new agent is one adapter in `server/adapters/`,
> not a rewrite: the wire protocol, output zone, security model, and generative
> UI consume `WireMsg` only. No generic homegrown agent, no proxy, no privileged
> agent — onboarding lets you pick the agent per session. Claude Code is the
> reference adapter, so this document's deeper sections use it for concrete
> examples; Codex and Gemini CLI are the same pattern (`server/adapters/codex.ts`,
> `server/adapters/gemini-cli.ts`).

Think of it as a terminal successor, not a chat app: monospace command strips
in, rich rendered output back. The vision is a **strict superset of the
terminal** — same engine, and never *less* visibility than the terminal gives:
thinking, full tool detail and diffs, subagent progress, the live task list,
and token/cost usage are all surfaced (Phase T2, shipped). Richness is added
on top of raw visibility, never traded against it.

![Mirafold demo — ask about a repo and get a card, a table, and real links; paste data, get a live chart, pin it, and the agent updates it in place](demo/demo.gif)

*Two prompts, live and unscripted: ask about a repo → the agent answers with
an overview card, a dependency table, and doc links — clicking one opens the
real page. Then paste latency numbers → it chooses a line chart (hover it:
a real component, not a picture) → **pin** it → one more ask, and the agent
updates the **pinned** chart in place.*

This document is the technical orientation for someone taking ownership of the
codebase. Companion documents:

- **[PLAN.md](PLAN.md)** — the phased build plan. Every step has
  Goal / Build / Files / Done-when. Shipped so far: **Phases 0, 1, T, 2, 3, T2,
  and P** (three faithful agent skins — Claude Code, Codex, Gemini CLI), all
  of Phase 4, L.1, and the buildable core of **Phase R** (the hosted relay:
  R.1 dial-out + envelope, R.3 per-pair E2E encryption, R.4's QR pairing +
  phone layout — all verified against the in-repo stub). What remains is the
  relay *deploy* (R.2, Fly.io), billing (R.5), and launch day (R.6), plus
  demand-gated Phase L ergonomics. PLAN.md is the source of truth for what
  comes next; completed phases are archived in
  **[PLAN-ARCHIVE.md](PLAN-ARCHIVE.md)**.
- **[BUSINESS.md](BUSINESS.md)** — positioning, wedges, pricing, and the
  milestone gates that sequence the plan. The two build-relevant conclusions:
  ship the Phase 1 demo before Phase T, and keep every seam local-first.
- **[docs/ADAPTERS.md](docs/ADAPTERS.md)** — the normative adapter
  specification: what an adapter must/should/may/must-never do, the shipped
  capability matrix per provider, and the exact checklist for adding
  provider #4. Read it before touching anything in `server/adapters/`.

---

## 1. The one-paragraph mental model

The server holds **warm agent sessions** in a registry — each adapter keeps
its agent warm its own way: Claude Code is one long-lived `query()` from
`@anthropic-ai/claude-agent-sdk` fed prompts through an async generator (so
the conversation and prompt cache never reset between turns), Codex a
persistent SDK `Thread`, Gemini CLI one process per turn resumed via
`--session-id`/`--resume`;
a WebSocket connection is a *viewport* that attaches to one. The session's
SDK event stream is **normalized into a tiny wire protocol** (`WireMsg`),
buffered for replay, and fanned out to every attached viewport. The browser is split into two zones
with a hard security boundary: a **trusted shell** (prompt box + socket
client, never re-rendered by agent output) and an **output zone** that is
purely an *interpreter* of `WireMsg` — it renders whatever messages arrive
and has no other inputs. Growing the product = adding message types to the
wire protocol and handlers to the interpreter. Nothing else changes shape.

## 2. The two load-bearing contracts

Everything in the repo hangs off two interfaces. Internalize these and you
can navigate the whole codebase.

### 2.1 The wire protocol (`server/protocol.ts`)

The contract between server and browser. Currently on the wire:

```ts
// Server → browser
type WireMsg =
  | { type: "text_delta"; text: string }                           // streamed markdown
  | { type: "thinking_delta"; text: string }                       // T2.1: reasoning stream
  | { type: "status"; state: "thinking" | "tool"; label?: string } // activity line
  | { type: "turn_end" }                                           // finalize the turn
  | { type: "error"; message: string }
  | { type: "notice"; text: string;                                // F.2: degraded-service
      kind?: "retry" | "compaction" | "rate_limit" | "refusal" }   //   status line (dim)
  | { type: "render"; component: string; props: Record<string, unknown>; id: string }
    // ^ Phase 1: "mount registry component X with props P". Re-sending an id
    //   updates that component in place (the live-pinned-widget mechanism).
    //   `component` is a plain string so unknown instructions stay
    //   representable and can degrade gracefully (Step 1.4).
  | { type: "artifact"; html: string; id: string; title?: string } // Phase 3: sandboxed UI
  // Tool records (T.1). T2 widened both with OPTIONAL fields old clients
  // ignore: `input` (full args → diffs/code), `parentId` (subagent nesting),
  // `truncatedBytes` (explicit elision past the output cap).
  | { type: "tool_use"; name: string; detail?: string; id: string;
      input?: Record<string, unknown>; parentId?: string }
  | { type: "tool_result"; output: string; isError?: boolean; id: string;
      truncatedBytes?: number; parentId?: string }
  | { type: "permission_request"; tool: string; detail: string; id: string } // T.3
  | { type: "user_prompt"; text: string }              // 4.2: server-echoed user turn
  | { type: "session_created"; sessionId: string; cwd: string;    // 4.2: attach reply
      agent?: AgentName; resumed?: boolean }       // (P.4: + agent; 4.4: + resumed —
                                                   //  true ⇒ tail replay, don't reset)
  | { type: "agents"; agents: { agent: AgentName; live: boolean }[]; // P.4: onboarding
      default: AgentName; cwd?: string; home?: string;             //   (4.8: + cwd/home)
      relay?: { url: string; code: string } }        // R.4: pairing info for the QR —
                                                     //   local viewports only
  | { type: "usage"; model: string; inputTokens: number;           // T2.6: status-bar
      outputTokens: number; costUsd?: number }                     //   accounting
  // 4.9: the `!` passthrough's lifecycle + OUTPUT stream (broadcast, replayed).
  // What the user types into the command goes browser→server only (bang_input).
  | { type: "bang_start"; command: string; id: string }
  | { type: "bang_output"; data: string; id: string }
  | { type: "bang_end"; id: string; exitCode: number | null }      // null = killed
  | { type: "pong" }                                     // 4.4: liveness reply
  | { type: "sessions"; sessions: SessionMeta[] };  // 4.6: fleet snapshot for
                                                    //   watch_sessions viewers
// 4.4: the whole union is intersected with { seq?: number } — the registry
// stamps a session-scoped increasing seq on every BROADCAST message (never
// on per-viewport plumbing), giving reconnects a resume cursor.

// Browser → server
type ClientMsg =
  | { type: "prompt"; text: string }
  | { type: "interrupt" }                                       // T.2: halt the turn
  | { type: "permission_response"; id: string; allow: boolean } // T.3
  | { type: "attach"; sessionId: string; afterSeq?: number } // 4.2: join a session…
                                          // (4.4: afterSeq ⇒ tail-only resume)
  | { type: "create"; cwd?: string; agent?: AgentName } //  …or start a fresh one (P.4)
  | { type: "action"; action: Action; sourceId: string } // Phase 2: component action
  | { type: "bang"; command: string; id: string }        // 4.9: run `!cmd` in a PTY
  | { type: "bang_input"; data: string; id: string }     //   EPHEMERAL: PTY stdin —
                                                         //   never broadcast/buffered/logged
  | { type: "bang_kill"; id: string }
  | { type: "ping" }                                     // 4.4: liveness probe
  | { type: "watch_sessions" }             // 4.6: be a fleet watcher, not a viewport
  | { type: "rename"; sessionId: string; name: string }; // 4.6: fleet rename
```

`Action` (also in `protocol.ts`) is the complete vocabulary of what a
component interaction may do — `prompt` (round-trips as a user turn), `tool`
(runs a server-side allowlisted tool, §5.4), or `state` (pin/unpin;
output-zone-local, never sent).

**The cardinal rule: later phases ADD message types (or OPTIONAL fields);
existing shapes never change.** That's what makes every phase additive and
keeps old clients from breaking. The union above is complete for everything
shipped. The Phase R relay proves the rule from below: it carries these same
frames as **opaque, end-to-end-encrypted payloads** inside its own tiny
envelope (`server/relay/relay-protocol.ts` — a transport layer under `WireMsg`,
not new message types), and R.4 added exactly one optional field
(`agents.relay`, the pairing info for the connect-a-device QR — sent to
local viewports only, never across the relay).

**The `!` passthrough (Step 4.9).** A prompt starting with `!` never reaches
the model: the trusted shell intercepts it and the server runs the rest in a
**real PTY** (`node-pty`) in the session's cwd — so unlike the terminal
agents' own pipe-based `!`, interactive programs work: `sudo` prompts,
`ssh` host-key questions, y/n confirms. Output streams to every viewport and
the replay ring like anything else; the finished transcript
(`<bash-input>`/`<bash-output>`) is injected into the agent's context with
the next prompt, so the model sees what you ran (agent-neutrally, via
`pushPrompt` — no per-adapter code). Stdin is the one **ephemeral** path:
only the issuing viewport gets the input bar (it auto-masks on password
prompts), and `bang_input` goes straight to the PTY — never broadcast,
buffered, or logged, so a password can't reach the ring or a second tab.
Echo discipline is the terminal's own: echo-on input comes back as PTY
output (visible everywhere, as in a terminal); password prompts turn echo
off, so nothing comes back. A full embedded terminal (xterm.js consuming the
raw stream — `!vim`, `!top`) is deferred Tier 2; today's stream is
ANSI-stripped plain text, one command at a time per session.

Both sides import the *same file*: the web build resolves `@protocol` to
`server/protocol.ts` via a Vite alias + tsconfig path. There is one source of
truth for message shapes, enforced by the type checker on both ends.

### 2.2 `AgentSession` (`server/adapters/`)

```ts
interface AgentSession {
  pushPrompt(text: string): void;              // feed a user turn in
  onMessage(cb: (msg: WireMsg) => void): void; // subscribe to normalized output
  interrupt(): void;                           // T.2: halt the turn; stay warm
  resolvePermission(id: string, allow: boolean): void; // T.3: browser's answer
  close(): void;
}
```

Four implementations live behind this interface in `server/adapters/`, one per
agent plus the mock, and the server (and everything downstream, including the
entire front end) cannot tell them apart — they all emit `WireMsg` and nothing
else. `createSession()` resolves which one from config + per-session onboarding:

- **`ClaudeCodeSession`** — Claude Code via the Anthropic Agent SDK (the
  reference adapter; Claude-specific fidelity is scoped here).
- **`CodexSession`** — OpenAI's Codex via `@openai/codex-sdk` (spawns the
  `codex` CLI, streams its JSONL events → `WireMsg`).
- **`GeminiCliSession`** — Google's Gemini CLI via its headless `stream-json`
  interface (one process per turn, warm across turns via `--session-id`/`--resume`).
  Note: to inject the render MCP server, this adapter writes a
  `.gemini/settings.json` into the session's working directory (merged
  non-destructively over anything already there) — so pointing a Gemini session
  at a project drops that file in it.
- **`MockSession`** — a scripted stand-in used automatically when the chosen
  agent has no credentials. Emits every wire message type with
  realistic pacing, drawing replies from a shuffled deck of five demo
  templates (welcome, analytics report, code review, migration plan,
  research brief), and ends every turn with a schema-valid `render` so the
  Phase 1 component pipeline is exercised API-free.

This is a deliberate development strategy, not a testing afterthought:
**every UI capability is built and verified against the mock first**; live
verification with a real key comes last. You can develop the whole front end
without spending a token.

**What agent #N actually requires (R.4h).** The five method signatures above
undersell the seam's real contract — these properties of the underlying
engine are load-bearing in every shipped adapter, and an agent that lacks one
needs a workaround (or isn't a fit) *before* the adapter is started:

- **MCP over stdio**, so the shell can inject its `render_*` / `emit_artifact`
  tools without touching the agent's request path.
- **The engine's own event stream must show tool results** (not just tool
  calls) — the render tools return a `renderId` acknowledgment, and the
  adapter reads it riding back through that stream to correlate `render`
  messages with the turn that authored them.
- **A discernible turn boundary** — something in the stream that reliably
  means "this turn is over", to emit `turn_end` from.
- **A warm-session mechanism** — either a long-lived process or a
  resume-by-id flag (Gemini's `--session-id`/`--resume`), so a session
  survives across prompts without replaying history.
- **An interrupt** that halts the current turn while keeping the session warm.
- **A way to auto-trust the injected MCP server** (config file, CLI flag, or
  settings merge) — a first-turn interactive "trust this server?" prompt has
  no terminal to answer it here.

The full adapter contract — semantics beyond these five method signatures,
the per-provider capability matrix, and the add-a-provider checklist — is
**[docs/ADAPTERS.md](docs/ADAPTERS.md)**, the normative document for this
seam.

## 3. The security model (do not violate)

Two zones in the browser, hard boundary between them:

```
┌─ OUTPUT ZONE — agent-controlled, sandboxed ──────────┐
│   Level 1: styled markdown            (shipped)      │
│   Level 2: registry components        (shipped)      │
│   Level 3: sandboxed-iframe artifacts (shipped)      │
├─ SHELL — TRUSTED, never re-rendered by the agent ────┤
│   prompt box · WebSocket client · all credentials    │
└──────────────────────────────────────────────────────┘
```

The invariants, and where each is enforced today:

- **The API key never reaches the browser.** It lives only in the server
  process (`server/index.ts` reads env; nothing ever serializes it into a
  `WireMsg`).
- **The agent only emits content into the output zone.** `RenderZone` is the
  sole consumer of agent output, and it only ever renders — it holds no
  socket, no credentials, no callbacks into the shell beyond subscription.
- **No raw agent HTML outside the sandboxed iframe.** `react-markdown` never
  emits raw HTML from its source by default, so streamed markdown can't
  smuggle script or markup (same rule in the registry's `Md` component).
  Links are forced to `target="_blank" rel="noopener noreferrer"`. The one
  place agent HTML executes is `Artifact.tsx`'s opaque-origin iframe.
- **Tool use is gated server-side** (`server/permissions.ts`, see §5.3);
  anything outside the auto-allowed set pauses the turn on a shell-drawn
  permission bar in the browser, deny by default (T.3).
- **Component actions are mediated server-side** (`server/actions.ts`, see
  §5.4): the client never makes an arbitrary call; `tool` actions run against
  an explicit allowlist with validated args, and every action is logged.
- **WebSocket hijacking guard**: browser connections must present a loopback
  `Origin`; a malicious web page can't drive your local agent through a
  cross-site socket. Non-browser clients (wscat, tests) send no Origin and
  pass — they aren't weaponizable the way a browser socket is.
- **Per-launch auth token** (`server/index.ts`, Step 4.5): loopback keeps the
  network out, but "same machine" includes other user accounts on a shared box —
  and the socket drives a shell. A random token generated each launch gates both
  the served app and the WebSocket: the launcher opens a URL carrying it, the
  browser stores it as an `HttpOnly; SameSite=Strict` cookie (so refreshes, new
  tabs, and fleet links just work), and connections without it get a 403 / a
  refused handshake. Set `MIRAFOLD_TOKEN=""` to disable it on a single-user machine
  (the dev server does this — the Vite `:5173` proxy is cross-origin and can't
  present the cookie); set `MIRAFOLD_TOKEN=<value>` to pin one. **With auth off the
  loopback-Origin guard is the only gate, and it admits any page served from
  localhost on any port** — so another local dev server, or a hostile package's
  local server, could drive the agent. Keep auth on outside the single-user dev
  case; the daemon logs a loud warning at startup when it's off.
- **The daemon's own `.env` is never readable through a tool**
  (`server/permissions.ts`): the secret-path guard denies `Read`/`Grep`/`Glob`
  at `.env`/`.env.local`, and `WebFetch`/`WebSearch` are not auto-allowed (they
  ask, like the terminal) so a prompt injection has no silent read→exfil path.
  Defense-in-depth, not a full boundary.
- **Resource caps**: one inbound WS frame is capped (`MAX_WS_PAYLOAD`, 1 MB) and
  concurrent sessions are capped (`MAX_SESSIONS`, 100) so a runaway or hostile
  local client can't exhaust memory/PTYs. The shell page also ships
  defense-in-depth headers (CSP, `nosniff`, `X-Frame-Options: DENY`).
- **The relay is untrusted for resource pressure too** (`server/relay/relay-client.ts`):
  viewport announcements past `MAX_REMOTE_VIEWPORTS` (16) are refused, and a
  handshaken viewport with no authenticated frame for `RELAY_VIEWPORT_IDLE_MS`
  (90 s) is dropped — so a hostile relay (or a replayed handshake hello, which
  can never produce an authentic frame) can't park connections or grow daemon
  state. A pinned `MIRAFOLD_RELAY_CODE` under 16 chars is refused at startup with
  a minted fallback: the code is the remote path's only credential, and a
  guessable one would be brute-forceable remote shell access.

Agent-authored executable UI (Phase 3, shipped) runs only inside
`web/src/Artifact.tsx`'s sandboxed iframe: `allow-scripts` without
`allow-same-origin` gives the content an opaque origin (cookies, storage, and
the parent DOM are structurally unreachable), and an injected
`default-src 'none'` CSP cuts every network path — verified against a hostile
artifact with every escape probe blocked; the threat model is documented
inline in the file. Artifacts talk back through exactly one channel: a
nonce-stamped postMessage bridge (`genui.prompt` / `genui.tool`) validated at
every hop (source window, opaque origin, per-mount nonce, strict shape,
rate limit) and forwarded through the same server-side allowlist mediation
components use. Broken artifacts degrade to their source as styled code, and
a self-navigating artifact is detected by liveness and blanked. The trusted
shell is why this product can safely let an agent paint UI at all — treat the
boundary as inviolable, and treat "the shell draws it, the agent can't fake
it" as the extension of the same rule: the pin affordance (a frame *around*
rendered blocks, unreachable from agent props), the T.3 permission bar, the
artifact's "sandboxed" chrome, and the status bar are all drawn this way.

## 4. Repository layout

```
server/            the local daemon (Node, run with tsx)
  protocol.ts        WireMsg/ClientMsg/Action — the shared wire contract
  registry-spec.ts   zod shapes per component — spec = tool schema = validation
  render-tools.ts    render_* tools as an in-process MCP server (Claude adapter) + RENDER_GUIDANCE
  render-mcp.ts      the same render_* tools as a standalone stdio MCP server (Codex/Gemini)
  adapters/          one AgentSession per agent: claude-code.ts, codex.ts,
                     gemini-cli.ts, mock.ts (+ index.ts seam, types.ts,
                     async-queue.ts, render-mcp-cmd.ts, *.spike.md probe notes)
  registry.ts        SessionRegistry: sessions decoupled from connections (4.2)
  actions.ts         Phase 2 mediation: allowlisted tools component actions may run
  permissions.ts     canUseTool policy: workspace gating + browser prompts (T.3)
  auth.ts            the 4.5 auth predicates (token cookie, loopback Origin) —
                     pure functions; index.ts wires them into HTTP + WS
  pty.ts             the `!` passthrough's PTY runner (node-pty, 4.9)
  connection.ts      one viewport's server side, transport-agnostic (R.1) —
                     shared verbatim by local sockets and relay viewports
  relay/             the remote-viewport path (H.2/H.3):
    relay-protocol.ts  the relay envelope + pairing-code mint (R.1/R.3)
    relay-crypto.ts    per-pair E2E encryption, WebCrypto-only — the same file
                       runs in the browser via the @relay-crypto alias (R.3)
    relay-client.ts    daemon dial-out: no listening port for remote access (R.1)
    relay-stub.ts      in-repo dumb-forwarder stub for dev + tests
    relay-test-client.ts  shared RemoteClient test helper (the browser side of
                       the encrypted relay channel) used by relay.itest.ts and
                       relay-service.itest.ts
  version.ts         reads package.json's version at build time (R.4g)
  index.ts           Express + ws server; connections attach as viewports
web/               the browser app (React 19 + Vite)
  index.html         entry html
  src/main.tsx       mounts <Shell/>, imports global CSS + highlight theme
  src/Shell.tsx      TRUSTED SHELL: socket + prompt box + permission bar +
                     status bar; the message bus
  src/Onboarding.tsx first-run card: pick the agent + working directory (P.4/4.8)
  src/PromptBox.tsx  the command bar (auto-grows to 8 lines; Enter sends)
  src/RenderZone.tsx OUTPUT ZONE: WireMsg interpreter → entries + status line,
                     incl. thinking blocks, artifacts, and subagent grouping
  src/ToolBlock.tsx  tool-call records: collapsed row, expands to input diff +
                     output with elision marker (T.1/T2.2/T2.3)
  src/StatusBar.tsx  workbench strip: model · session · cwd · conn · usage (T2.6)
  src/PinDock.tsx    right-side dock for pinned components (live via entries)
  src/Artifact.tsx   Level 3 host: sandboxed iframe for agent-authored UI (Phase 3)
  src/registry/      Card, List, Table, LinkGroup, Chart, TodoList, Md +
                     RenderBlock (validate → fallback → error boundary) +
                     ActionRow/context
  src/FleetView.tsx  mission control at / (4.6): live session list, rename,
                     new-session affordance; routing lives in main.tsx
  src/ConnectDevice.tsx  shell-owned "⧉ pair" affordance: QR of the pairing
                     URL, status bar + fleet header (R.4)
  src/ws.ts          SocketClient: typed send/onMessage, hello, seq cursor,
                     heartbeat (half-open detection) + capped backoff (4.4);
                     on a relay page (#code= fragment) it handshakes and
                     seals/opens every frame via @relay-crypto (R.3)
  src/agents-meta.ts display labels + per-agent "how to connect" hints,
                     reached only via agentLabel()/connectHint() so an
                     unknown agent name degrades to its raw string (R.4h)
  src/version.ts     the web bundle's own build version (R.4g)
  src/styles.css     the design identity in CSS (see §7)
bin/               mirafold launcher (4.10): spawns dist-server, opens browser
demo/              the M1 demo GIF embedded at the top of this README
docs/              ADAPTERS.md — the normative adapter specification (§2.2);
                   local-models.md — running against Ollama/LM Studio/vLLM (§8)
relay-service/     pointer README only (Phase G): the hosted relay lives in
                   the private sibling repo `genui-relay`, the single source
                   of truth since its first deploy. The real-daemon itest
                   (server/relay/relay-service.itest.ts) imports the relay under
                   test from ../genui-relay/src/ and guards the routing
                   contract against server/relay/relay-protocol.ts
dist/              built front end (vite build output; served by Express)
dist-server/       esbuild server bundles (4.10): index.js + render-mcp.js —
                   what the installed `mirafold` actually runs; gitignored
PLAN.md            the phased build plan (source of truth for next steps)
PLAN-ARCHIVE.md    completed phases (0, T, 1, 2, 3, T2, P) with their status notes
BUSINESS.md        strategy; gates that sequence the plan
vite.config.ts     web root, @protocol/@relay-crypto aliases, /ws proxy → :3000
tsconfig.json      one tsconfig for both sides; @protocol/@relay-crypto paths
.env.example       MIRAFOLD_AGENT + per-agent credentials/models (ANTHROPIC_API_KEY /
                   DEFAULT_MODEL, OPENAI_API_KEY / CODEX_MODEL, GEMINI_API_KEY /
                   GEMINI_MODEL) + PORT
```

Tests live beside their source, tier picked by suffix — `*.test.ts` /
`*.itest.ts` / `*.e2e.ts` (§8) — so they're omitted from the tree above.

There is intentionally **no** shared `common/` package, monorepo tooling, or
build step for the server — the repo is one yarn package, the server runs
TypeScript directly via `tsx`, and the single shared file (`protocol.ts`)
crosses the boundary via a path alias.

## 5. The server, top to bottom

### 5.1 `index.ts` + `registry.ts` — transport and the session registry

Express serves `dist/` (the built front end; in dev you use Vite's server
instead) plus `/` (mission control, 4.6) and `/s/<id>` as client-side routes,
and hosts a `ws` WebSocketServer at `/ws`. Both the HTTP app and the socket are
gated by the per-launch auth token (§3) behind the loopback-Origin guard — the
pure predicates live in `server/auth.ts`, wired in here; a capped inbound
frame (`MAX_WS_PAYLOAD`) and session ceiling (`MAX_SESSIONS`) bound resources.

**Sessions are decoupled from connections** (Step 4.2). A connection is a
*viewport* onto a session in the `SessionRegistry`: its first message is a
hello — `attach` (session id taken from the `/s/<id>` URL) or `create` — and
the server replies `session_created`, replays the session's buffered history,
then subscribes the socket to the live stream. Every emitted `WireMsg` is
fanned out to all attached viewports and kept in a ring buffer (4000
messages) for replay, so a refresh or a second tab repaints the same
transcript. **Reconnects resume, they don't repaint** (4.4): every broadcast
message carries a session-scoped `seq`; a reconnecting viewport sends the
last seq it saw and, when the tail is still buffered, the server replays
only the unseen messages under `session_created{resumed:true}` — mid-turn
streaming continues into the same DOM block, pins and scroll survive. A
cursor that has fallen off the ring (or a fresh page) takes the full-replay
path as before. Closing a tab merely detaches; a session with no viewports dies
only after an idle timeout (default 60 min, `SESSION_IDLE_TIMEOUT_MS`). Each
session runs in a real working dir — default: the directory the daemon was
launched from, exactly like a terminal agent (Step 4.8) — or any existing
directory typed at onboarding (`~` expands; a missing path rejects the
create, like `cd`). Mental model: session ≈ project. A stale/unknown attach
id falls back to a fresh session rather than an error page.

Inbound messages route accordingly: `prompt` is echoed onto the session
stream as `user_prompt` (all viewports render the command strip identically —
there is no local echo) and pushed into the session; `interrupt` and
`permission_response` forward to the session; `action` hits the Phase 2
mediation path (§5.4).

### 5.2 `adapters/claude-code.ts` — the warm Claude Code session

`ClaudeCodeSession` is the reference adapter (Codex and Gemini are the same
`AgentSession` shape — §2.2 — driving their own engines). Its key mechanics:

- **One `query()` for the life of the object.** The SDK call's `prompt` is
  an async generator (`promptStream`) backed by a tiny unbounded
  `AsyncQueue`. `pushPrompt(text)` pushes into the queue; the generator
  yields it to the SDK as a user message. Because the query never ends
  between turns, the conversation stays **warm and prompt-cached** — this is
  the "warm session loop" and it's why multi-turn feels instant and cheap.
- **`pump()` normalizes SDK events into `WireMsg`:**
  - `stream_event` → `content_block_delta` (text) becomes `text_delta`
    (enabled by `includePartialMessages: true`, which is what gives
    token-level streaming rather than whole-message chunks); a `thinking`
    delta becomes `thinking_delta` (T2.1 — the reasoning stream, folded
    client-side); `content_block_start` for a tool_use block becomes
    `status:{state:"tool", label:<tool name>}`.
  - Full `tool_use` blocks become `tool_use` records (Phase T.1) carrying the
    one human-salient argument as `detail` **and** the full `input` (T2.2 —
    the client renders Edit/Write inputs as diffs/code); a later `tool_result`
    with the same id completes the record, capped by `capOutput` with an
    honest `truncatedBytes` (T2.3). Results are only forwarded for ids the
    session announced.
  - **Subagent traffic** (events with a `parent_tool_use_id`): its text and
    thinking stay dropped — a subagent's monologue must not paint into the
    transcript — but its tool *calls* are now forwarded tagged with
    `parentId` (T2.4), which the client nests under the owning Task row.
  - **Task list** (T2.5): the SDK's `TaskCreate`/`TaskUpdate` family (its
    successor to `TodoWrite`) is folded into one live `todo-list` render that
    updates in place; the raw Task* rows and their results are swallowed.
  - `result` → `error` (if `is_error`) then a `usage` record (T2.6 —
    per-turn tokens plus the SDK's cumulative `total_cost_usd`) then always
    `turn_end`.
- **`interrupt()`** (Phase T.2) halts the in-flight turn via the SDK; the
  session stays warm for the next prompt.
- **Permission prompts** (Phase T.3): when `permissions.ts` needs the user,
  the session emits `permission_request` and blocks that tool call until
  `resolvePermission(id, allow)` arrives from the browser — or denies on
  timeout (default 60 s, `PERMISSION_TIMEOUT_MS`). Deny is the default
  posture on timeout, disconnect, and interrupt.
- **`close()`** pushes a sentinel that ends the generator and calls
  `interrupt()` on the SDK query.
- Session options: `cwd` is the session's own workspace dir handed in by the
  registry (created on construction — spawning into a missing cwd fails with
  a misleading SDK error), model comes from `DEFAULT_MODEL` (unset → the
  SDK's own default; `.env.example` suggests `claude-sonnet-4-6`, with
  `claude-opus-4-8` switchable per the locked decisions), and `canUseTool`
  comes from `permissions.ts`. `settingSources`
  is left **unset on purpose**, which matches the CLI default (user + project
  + local): Mirafold is a different *view* of the terminal, so a user's own
  Claude Code config — their `settings.json` permission allowlists/deny rules,
  their CLAUDE.md, their memory — applies here exactly as in the terminal.
  Switching to this from regular terminal use must be seamless and
  unsurprising, so honoring those settings (and letting "remember X" write to
  the real memory dir) is correct, not a leak. `canUseTool` still runs for
  anything the user's own rules don't already decide.
- **Generative UI (Phase 1):** the session mounts an in-process MCP server
  (`server/render-tools.ts`) exposing side-effect-free `render_card` /
  `render_list` / `render_table` / `render_chart` / `render_links` tools
  whose input schemas are the registry spec (`server/registry-spec.ts`) plus
  an optional `id` for update-in-place. Calling one emits a `render` WireMsg
  at that point in the stream and returns the id to the model.
  `RENDER_GUIDANCE` (appended to the `claude_code` system-prompt preset)
  teaches when to prefer a component over prose — and that raw HTML/SVG
  renders as literal code, so the agent never improvises markup (arbitrary
  visuals are Phase 3's sandboxed artifacts). The tool schemas' `.describe()`
  strings are written for the model. The agent reaches for components
  unprompted — verified live.

`MockSession` implements the same interface with `setTimeout`-scheduled
emissions: streamed `thinking_delta`, fake `tool_use`/`tool_result` records
(incl. an Edit with a real before/after and a Write), a `usage` record, the
reply streamed in 16-char chunks at ~12ms, then `turn_end`. Keyword hooks in
the prompt drive every other capability API-free — `artifact`/`broken`/
`navigates` (Phase 3 + its fallbacks), `subagent`/`delegate` (nested Task),
`todo`/`plan` (live checklist), `huge` (the elision marker), `dangerous`
(permission prompt). `close()` clears all pending timers.

### 5.3 `permissions.ts` — the tool policy

`makeCanUseTool(workspaceDir, ask)` returns the SDK's `canUseTool` callback.
The posture is **match the terminal**. Because the session inherits the user's
Claude Code `settings.json` (§5.2), the SDK's own allow/deny rules resolve
**first** — anything the user allowlisted runs without a prompt, anything they
denied is blocked — and `canUseTool` is only the interactive fallback for
undecided calls: the terminal's approval prompt, drawn on the shell's permission
bar instead of the TUI. Deny is the default on timeout, disconnect, and Esc.

1. **The daemon's own `.env`/`.env.local`** → denied to every auto-allowed
   read tool that takes a path (Read, NotebookRead, Grep, Glob), so the read
   side of a read→exfil chain is blocked. Defense-in-depth (the API key lives
   there): still string-based, so `Bash cat .env` isn't caught here — but Bash
   asks.
2. **Local read-only tools** (Read, Glob, Grep, TodoWrite, Task, NotebookRead)
   and our side-effect-free `mcp__ui__*` render tools → allowed without a
   prompt.
3. **Network tools (WebFetch, WebSearch) and everything consequential**
   (Write/Edit/MultiEdit/NotebookEdit, Bash, and any unknown tool) → **asks**.
   The terminal prompts on undecided fetches too, and asking denies a prompt
   injection a silent exfil egress. There is deliberately no "auto-allow inside
   the workspace" — the terminal doesn't do that, so neither do we; a user who
   wants specific commands promptless allowlists them in `settings.json`
   exactly as in the terminal. (An interim build auto-allowed in-workspace
   bash/writes and heuristically confined Bash with a regex; both were
   deviations from terminal parity, removed 2026-07-05.)

### 5.4 `actions.ts` — component action mediation (Phase 2)

`tool` actions emitted by rendered components run **here**, never in the
client: an explicit allowlist (`ACTION_TOOLS`) maps names to zod-validated
args and a handler scoped to the session's workspace. Off-list names and
invalid args are rejected and logged; every run is logged. The result is
broadcast to all viewports as a `tool_use`/`tool_result` pair, so an
action's effect is a visible transcript record. (`prompt` actions round-trip
through the server as a normal user turn; `state` actions never leave the
output zone.)

## 6. The front end, top to bottom

### 6.1 `Shell.tsx` — the trusted shell and its message bus

`Shell` builds (once, in a `useMemo`) a tiny **bus**: a `SocketClient` plus a
listener set. The URL is the session identity — `/s/<id>` — so the bus's
hello is `attach` (id present) or `create`, and `session_created` writes the
id back into the URL via `history.replaceState`. It exposes a handful of
capabilities downward, and nothing below the shell ever holds the socket:

- `subscribe(listener)` — RenderZone's only way to receive messages.
- `sendPrompt(text)` — PromptBox's only way to send. No local echo: the
  server broadcasts the `user_prompt` to every viewport (including this
  one), so all tabs stay identical.
- `interrupt()` — wired to Esc (page-wide while a turn is in flight) and the
  prompt box's stop affordance.
- `answerPermission(id, allow)` / `sendAction(action, sourceId)` — the T.3
  and Phase 2 sends.

`ZoneMsg = WireMsg | {type:"zone_reset"}` is the output zone's full input
vocabulary: the wire protocol plus one local control message that clears the
transcript before a replay repaints it (fired on a non-resumed
`session_created`; a tail resume skips it so the zone keeps appending).

The shell also owns two pieces of shell-drawn UI the agent can't fake: the
**permission bar** (pending `permission_request`s, oldest first, allow/deny —
requests that outlive their turn are voided) and the **tab status light**
(title + favicon reflect idle/busy/permission, so a row of tabs reads as a
fleet view). Busy state is derived entirely from the wire — `user_prompt`
sets it, `turn_end` clears it — so a replayed in-flight turn restores it
correctly.

### 6.2 `ws.ts` — `SocketClient`

A thin typed WebSocket wrapper: `send(ClientMsg)` / `onMessage(WireMsg)`.
Three behaviors matter:

- **The hello**: on every open it first sends the message `setHello`
  provides (`attach`/`create`), making the connection a viewport onto a
  registry session.
- **Auto-reconnect** (hardened in 4.4): on non-deliberate close it retries
  with capped exponential backoff (500ms doubling to a 5s cap), short-circuited
  the moment the network returns or the tab regains visibility. An app-level
  `ping`→`pong` heartbeat (25s interval, 8s deadline) detects half-open
  sockets — a wifi blip with no FIN — and forces them into the same reconnect
  path. Because the hello re-attaches with the last seen `seq`, the server
  resumes with a tail replay rather than a repaint (§5.1).
- **Send queueing**: sends while closed are buffered and flushed on open, so
  typing during a blip isn't lost.

In dev it connects to `ws://<page-host>/ws` and Vite proxies `/ws` to the
server on :3000; in prod Express serves both HTTP and WS on one port, so the
same relative URL works unchanged.

### 6.3 `RenderZone.tsx` — the interpreter

State: a flat list of `Entry`s — text blocks (`{kind:"text", …}`), rendered
components (`{kind:"render", …}`), tool records (`{kind:"tool", …}`, which
may carry `parentId` for subagent calls), thinking blocks (`{kind:"thinking",
…}`), and artifacts (`{kind:"artifact", …}`) — in the exact order they
arrived on the wire, plus an ephemeral `Status`. The reducer-like
subscription handles each `ZoneMsg`:

- `user_prompt` → append a done user text entry, show `thinking`.
- `thinking_delta` → append to the streaming **thinking block** (dim italic,
  its own id in a ref). The moment the turn's first real output arrives
  (text/render/tool/artifact/turn_end) it **folds to one dim line**, still
  expandable — this is the *collapse-on-finalize* pattern that lets the
  transcript keep every line of reasoning without the clutter (§7).
- `text_delta` → append to the **streaming text block**, or open one if
  none is active. The streaming block's id lives in a ref
  (`streamingId`), *not* derived from "last entry in the list" — this is a
  deliberate correctness detail: if the user sends a new prompt mid-stream,
  the user entry is appended after the streaming block, and deltas still
  route to the right block by id instead of gluing the reply's tail onto
  the wrong one.
- `render` → if the wire `id` has been seen, **update that entry's props in
  place** (this is what keeps pinned widgets live); otherwise append a
  render entry and close the streaming text block, so later deltas open a
  new block *after* the component — the transcript keeps wire order.
  Dispatch goes through `RenderBlock` (`web/src/registry/RenderBlock.tsx`),
  the single guarded path shared with the pin dock: unknown component or
  schema-invalid props degrade to a quiet warning + raw props as styled
  code, and a component that throws anyway is caught by a per-block error
  boundary — a malformed instruction can never break the UI.
- `tool_use` / `tool_result` → append a tool entry, then complete it by id
  when the result lands. Tool entries render through `ToolBlock.tsx` as dim
  one-line monospace records, collapsed by default (errors arrive expanded);
  the expansion shows the full input — Edit/Write as a colored diff / code
  (T2.2) — and any `truncatedBytes` as an explicit elision marker (T2.3). A
  tool with `parentId` isn't rendered top-level: it's grouped under its Task
  row in a collapsible `SubagentGroup` ("⚙ subagent · N calls", T2.4).
- `artifact` → route to `Artifact.tsx` (the sandboxed iframe, Phase 3);
  re-sending an id replaces it in place, same as `render`.
- `status` → set the activity line (`✳ thinking…` / `⚙ Bash`).
- `turn_end` → mark the streaming block done, finalize any dangling tool
  entries, clear the ref and status.
- `error` → rendered as a bold-prefixed assistant entry.
- `notice` → append a dim system-status line (F.2: retry / compaction /
  rate-limit / refusal — the events the terminal shows in degraded service).
  Unlike real output it does *not* fold the thinking block or close the
  streaming text block; a status aside isn't the turn's content starting.
- `zone_reset` → clear everything; the replay that follows repaints it.

**Actions (Phase 2):** `RenderBlock` wraps each rendered component in an
`ActionContext` provider that binds the block's render id as the action's
`sourceId` — components call `useAction()` / render an `ActionRow`, never
touching the socket. `state` actions (pin/unpin) are handled inside the zone;
`prompt` and `tool` actions go up through the shell's `sendAction` and
round-trip via the server (§5.4).

**Pinning (Step 1.6):** every rendered block gets a shell-drawn pin — a
hover 📌 over registry components, a control in the artifact's chrome bar
(outside the iframe, same trust rule as the badge). Pinning promotes the
block to a right-side dock (`PinDock.tsx`) and leaves a dashed stub holding
its place in history; the dock collapses to a thin edge tab and dissolves
when the last pin is removed. Pin state is pure output-zone state (wire ids,
render or artifact, in pin order) — no wire changes — and the dock renders
the same entry objects the transcript holds, so update-in-place keeps pinned
blocks live for free.

Assistant turns render through `react-markdown` + `remark-gfm` (tables,
task lists) + `rehype-highlight` (fenced code), with links forced to open
safely in a new tab. Auto-scroll keeps the bottom in view as content
streams.

Adding UI capability = adding a `case` here for a new message type (plus, in
Phase 1, dispatching `render` messages into a component registry). That's
the whole extension model.

### 6.4 `PromptBox.tsx`

A textarea with the green `❯` glyph that auto-grows with content (wraps and
newlines both) up to 8 lines, then scrolls internally — a thin scrollbar is
the "there's more" cue — and collapses back to one line on send. Enter
submits (trimmed, non-empty), Shift+Enter inserts a newline. No send
button — that's part of the identity, not an omission. While a turn is in
flight a `■ esc` stop affordance appears (T.2); it and the page-wide Esc key
both interrupt the turn, leaving the session warm.

## 7. Design identity (locked)

The visual language is a **terminal transcript, not a chat app** — worth
knowing because it constrains future UI work:

- Full-width canvas, no centered column. If long prose ever needs a cap, cap
  prose only (`max-width: 80ch`) — never tables, code, or components.
- **Mono-in / rich-out is the identity**: user input renders as a monospace
  "command strip" (tinted full-width band, green left edge, `❯` glyph) that
  *segments* the scrollback; everything between strips is agent output in
  proportional type with rich markdown. No bubbles, ever.
- Status is a dim, pulsing monospace activity line — not a spinner, not a
  pill.
- The palette is a semantic token system in `styles.css` (Step 4.3): one set
  of `--fg/--surface/--border/--accent`-family custom properties, two themes.
  **Dark is the default and the identity**; the light theme is a TRUE, unified
  light theme — the whole UI, terminal chrome included (prompt box, command
  strips, bang/permission/status bars, onboarding), flips to the light palette.
  Faithful re-skin: a real terminal switched to light mode has a light input, so
  ours follows suit — the input stays distinctly an input via border/inset/
  monospace, not a dark block. Code surfaces (`--code-*`, `--diff-*`, hljs
  github-dark) are pinned dark in both themes, so code reads as a terminal
  window on any canvas. Toggle: the ☾/☀ button in the status bar (persisted to
  localStorage, applied pre-paint in index.html).
- Motion: transcript entries mount with a 160ms rise; theme switches fade;
  all of it is disabled under `prefers-reduced-motion`.
- Side surfaces are emergent/collapsible — the pin dock only exists while
  something is pinned, and the status bar folds to a single connection dot.
- **Visibility superset + collapse-on-finalize** (the Phase T2 rule): the
  browser must never show *less* than the terminal — thinking, full tool
  detail, diffs, subagent progress, todos, and usage are all surfaced — but
  noisy-but-faithful streams render live during the turn, then fold to a dim
  expandable one-liner once the answer lands. Total fidelity, clean
  transcript; the web skin gets to do both, which the terminal can't. Every
  stream-handling decision passes one check: *would a terminal user miss
  this line?*

## 8. Running it

### Installed (Step 4.10 — the product path)

```sh
npm i -g mirafold
cd ~/your/project
mirafold          # boots the daemon here, opens the browser
```

Like launching `claude`/`codex`/`gemini`: sessions default to the directory
you ran it from, and a second `mirafold` in another project walks to the
next port (3001, …) and runs independently. `npx mirafold` is the
zero-install try path; `--no-open` skips the browser; `PORT` moves the base
port. The daemon prints (and opens) a URL carrying a per-launch auth token
(§3) — that token, held as a browser cookie, is what keeps another account on
a shared machine off your socket. With `--no-open` or on a headless box, open
the exact printed URL (it has the token); `MIRAFOLD_TOKEN=""` disables the token
on a single-user machine. The package ships only the launcher + the two esbuild bundles + the
built front end (9 files, ~264 KB tarball); agent credentials come from your
environment exactly as in a terminal (`ANTHROPIC_API_KEY`, `codex login`,
`GEMINI_API_KEY`) — none live in the package. **Native-module note:**
`node-pty` (the `!` PTY, Step 4.9) has prebuilt binaries for macOS and
Windows; on Linux npm compiles it at install, which needs `make`/`g++`/
`python3` — the accepted long-tail fallback, not something we engineer
around. *(Publishing to npm is the M2 launch action — until then, install
from a tarball. Prerequisites: `yarn` on PATH and a prior `yarn install`,
because `prepack` runs `yarn build`. Then: `npm pack` in the repo, and
`npm i -g ./mirafold-*.tgz`.)*

### Prerequisites (development)

- **Node 22** (any install method; this machine uses nvm with 22 as the
  default alias). The published package itself requires only Node ≥ 20.12.
- **yarn** for all package operations (via corepack: `corepack enable`).

### Development

```sh
yarn install
yarn dev          # concurrently: tsx watch server (:3000, blue) + Vite (:5173, green)
```

Open **http://localhost:5173**. Vite serves the front end with HMR and
proxies `/ws` to the server. With no `.env`, you're in **mock mode** — type
anything and the scripted personas exercise the full rendering pipeline.

To go live: `cp .env.example .env`, set the credential for whichever agent
you want live — `ANTHROPIC_API_KEY` (Claude Code), `OPENAI_API_KEY` or a
prior `codex login` (Codex), `GEMINI_API_KEY` (Gemini CLI) — and restart the
server; an agent without credentials keeps running the mock. **Closed models
are API-key here:** a Claude or Gemini *subscription* login is deliberately not
a live path — those providers' terms don't allow subscription use in a
third-party app, so the picker shows it as `blocked` and points you at the API
key (a Codex/ChatGPT subscription works locally, but not over the paid relay).
Point an agent at a local endpoint (Ollama, a proxy — e.g. `ANTHROPIC_BASE_URL`)
and it's BYO, no restriction. The one dated source of truth for the whole rule
is `server/provider-policy.ts`. The env file is
loaded with `process.loadEnvFile()` and is optional by design. Also settable
there: `MIRAFOLD_AGENT` (the default agent offered at onboarding), the per-agent
model overrides `DEFAULT_MODEL` / `CODEX_MODEL` / `GEMINI_MODEL` (unset →
that agent's own default), `PORT`, and these tuning knobs:
`SESSION_IDLE_TIMEOUT_MS` (unattended-session lifetime),
`PERMISSION_TIMEOUT_MS` (how long a permission prompt waits before denying),
`TOOL_OUTPUT_CAP_BYTES` (per-result output cap before the elision marker,
default 64 KB), `BANG_CONTEXT_CAP` (tail of a `!` transcript injected into
the agent's context, default 16 KB), `MAX_THINKING_TOKENS` (opt-in extended
thinking), `MAX_WS_PAYLOAD` (largest inbound WS frame, default 1 MB),
`MAX_SESSIONS` (concurrent-session ceiling, default 100), `MIRAFOLD_TOKEN`
(the socket auth token, §3 — set empty to disable, or pin a fixed value;
`yarn dev` sets it empty because the Vite `:5173` proxy is cross-origin and
can't carry the cookie), and the Phase R relay pair: `MIRAFOLD_RELAY_URL`
(ws/wss address of a relay — set, the daemon dials out and remote pairing
turns on; unset, the whole relay path is off), `MIRAFOLD_RELAY_CODE` (pin
the pairing code across restarts; unset, a fresh 128-bit code is minted per
launch and printed — a pin shorter than 16 chars is refused with a warning
and a minted code is used instead, because the code is the remote path's
only credential and a guessable one is remote shell access),
`MAX_REMOTE_VIEWPORTS` (ceiling on relay-announced viewports the daemon
will hold, default 16), and `RELAY_VIEWPORT_IDLE_MS` (a handshaken remote
viewport that sends no authenticated frame for this long is dropped,
default 90 s — the web client heartbeats every 25 s, so only a dead or fake
peer goes quiet that long). For dev, `node --import tsx server/relay/relay-stub.ts`
runs the in-repo stub relay on `:9100`.

**Fully local, no API key:** a session is local when the *agent* behind it
points at a local inference server — Claude Code against Ollama's Anthropic
endpoint, or Codex against Ollama/LM Studio/vLLM. The recipe (two env vars, or
one `config.toml` block) is **[docs/local-models.md](docs/local-models.md)**,
with an honest model/hardware table.

Individual processes: `yarn dev:server` / `yarn dev:web`.

### Production-ish

```sh
yarn build        # vite build → dist/  +  esbuild → dist-server/
yarn dev:server   # Express serves dist/ and ws on :3000
```

Open http://localhost:3000 — one port, no proxy. `yarn build` also emits the
packaged server (`dist-server/index.js` + `render-mcp.js`, all deps external);
`bin/mirafold.js` runs that bundle — you can exercise the installed code
path from the repo with `node bin/mirafold.js`. The Codex/Gemini adapters
spawn the render-MCP stub via `renderMcpCommand()`: the compiled twin when it
exists beside the code, tsx + TS source in dev.

### Checks

```sh
yarn typecheck    # tsc --noEmit over server + web + vite config (tests included)
yarn test         # Tier 1 — pure/unit, node:test + tsx, ~3s, run on every commit
yarn test:server  # Tier 2 — spawns the real daemon (mock-forced), drives real ws sockets, ~45s
yarn test:e2e     # Tier 3 — yarn build + headless Chrome (playwright-core), opt-in, ~75s
                  #   (files run sequentially — parallel Chrome suites flake on modest hardware)
```

The suite is **`node:test` + `tsx`, zero test-framework dependencies** — the
`test*` scripts are just aliases for `node --import tsx --test <glob>`. Tests
live next to their source; the suffix picks the tier: `*.test.ts` (Tier 1,
pure logic — security predicates, caps, all three adapters' event mapping on
synthetic events (Claude Code through an injected engine seam, Codex through
a stubbed thread, Gemini through a scripted binary), the `SocketClient`
reconnect state machine on a stubbed WebSocket, and the R.3 E2E crypto —
tamper/replay/reorder/wrong-key all rejected), `*.itest.ts` (Tier 2,
integration — the auth gate, DoS caps, the mock-turn wire grammar, the
interrupt/component-action wire paths, the permission deny-on-timeout,
registry replay/resume, the bang-secrets invariant, the stdio render-MCP
stub's ack contract over a real MCP handshake, the relay path over the
in-repo stub: byte-for-byte local/remote mirror, a ciphertext-only tap audit
of what the relay can observe, fail-closed tamper/wrong-code, daemon re-dial,
and — against the actual DEPLOYED relay's code, imported from the sibling
`genui-relay` checkout (not just the stub) — its own caps/rate-limit/
health-check hardening and a routing-contract guard), and `*.e2e.ts` (Tier 3 — token→cookie boot, a full turn
rendering in the DOM, the artifact iframe executing under the CSP with a
hostile-artifact containment proof (each defense verified by flipping it),
a second browser mirrored through the relay stub, a killed-mid-turn daemon
restart showing an honest "session ended" notice, the launcher's browser-open
guarantee (a stub `xdg-open` proves, from inside the spawned opener, stdio →
`/dev/null` + own session — a cold-started browser can never chatter into the
user's terminal), and the phone suite:
390×844 touch pairing, thumb permissions, offline→online mid-turn resume;
needs `google-chrome`, path overridable via `CHROME_BIN`).

Two rules the suite is built on: **no test may reach a real model** — Tier 2/3
spawn the daemon with every provider credential forced empty (a set env var
beats `.env`), so everything runs on the `MockSession`; and **Tier 3 rebuilds
first** because the daemon serves `./dist` and a stale build fails silently.

The project's broader verification convention (from PLAN.md) still applies:
every front-end step is verified end-to-end in headless Chrome via
`playwright-core` (real typing/clicks), and every capability is proven
against the mock before the live agent.

### The working directory

A session's working directory defaults to the directory the daemon was
launched from (`process.cwd()`) — terminal parity, Step 4.8 — and the
onboarding picker takes any existing path (`~` expands; a typo'd path rejects
the create instead of silently creating a stray dir). The trusted shell shows
the session's cwd at the prompt (`~/Projects/foo ❯`) and its leaf in the
status bar. File mutation and bash ask for approval on the shell's permission
bar exactly as in the terminal, honoring the allowlists in your inherited
`settings.json`.

## 9. Life of a turn (end to end)

1. User types in `PromptBox`, hits Enter → `Shell.sendPrompt(text)`.
2. Shell sends `{type:"prompt", text}` over the socket; the server
   broadcasts `{type:"user_prompt"}` onto the session stream → the command
   strip appears in every attached viewport, status shows `✳ thinking…`.
3. `server/index.ts` routes the prompt to the connection's registry session:
   `session.pushPrompt(text)`.
4. `Session`'s queue feeds the text into the async prompt generator; the
   warm SDK `query()` picks it up as the next user message.
5. The agent thinks/uses tools. Each tool call passes through `canUseTool` —
   auto-allowed calls flow, anything else pauses the turn on the browser's
   permission bar until the user answers (deny on timeout). The SDK's
   stream events flow through `pump()`: reasoning → `thinking_delta`, full
   tool calls → `tool_use`/`tool_result` records (subagent calls tagged with
   `parentId`), TaskCreate/Update → the live `todo-list`, text → `text_delta`.
6. Every `WireMsg` is buffered in the session's ring buffer and fanned out
   to all viewports; `SocketClient` dispatches to the bus; `RenderZone`
   interprets: the thinking block streams then folds, tool records append as
   collapsed rows, deltas accumulate into the streaming assistant turn,
   markdown re-renders as it grows.
7. The SDK emits `result` → server sends (`error` if failed, then) a `usage`
   record (feeding the status bar) then `turn_end` → RenderZone finalizes the
   turn, clears status. The session stays warm, waiting on the queue for the
   next prompt.

## 10. Where the code is going (orientation, not a roadmap copy)

Read PLAN.md for the real thing; the shape in one breath:

- **Shipped (as of 2026-07-05):** Phases 0 and 1 verified live (the M1 demo
  GIF above); **Phase T** — tool records in the transcript, Esc/stop
  interrupt, browser permission prompts — making it daily-drivable; the
  **session registry** (Steps 4.1/4.2) — sessions survive refreshes, fan
  out to multiple tabs, and live at `/s/<id>`; **Phase 2** — typed,
  server-mediated component actions (prompt / allowlisted tool / pin);
  **all of Phase 3** — the sandboxed artifact host (verified against a
  hostile artifact), the `emit_artifact` capability, the nonce-stamped
  action bridge, and graceful failure fallbacks; and **all of Phase T2** —
  full-stream visibility parity: thinking text (collapse-on-finalize),
  Edit/Write diffs, honest output truncation, subagent nesting, the live
  todo checklist, and the status bar with usage. The browser now shows
  strictly more than the terminal, never less.
- **Also shipped (2026-07-06, the identity + the product path):** **Phase P**
  — faithful browser skins for Codex (OpenAI) and Gemini CLI beside Claude
  Code, one adapter each (drive that agent's engine, normalize to `WireMsg`,
  inject the render tools via MCP; no homegrown loop, no proxy, no privileged
  agent); and the **run-anywhere Phase 4 core**: launch-dir sessions with a
  cwd picker (4.8), the interactive PTY `!` (4.9), packaging for
  `npm i -g` (4.10 — publish held for the M2 launch), semantic theming +
  light mode (4.3), seq-cursor resume + heartbeat (4.4), the per-launch auth
  token + the rest of the pre-launch security audit (4.5's auth slice), and
  **mission control** — the live fleet at `/` (4.6).
- **Also shipped (2026-07-07):** the three-tier test suite (§8) — 150+ tests,
  `node:test` + `tsx`, zero test-framework dependencies, no test ever reaches
  a real model.
- **Also shipped (2026-07-07):** Phase L.1 — the documented local path
  (`docs/local-models.md`), verified end-to-end against a real local model.
- **Also shipped (2026-07-07):** the buildable core of **Phase R** — the
  relay envelope + daemon dial-out (R.1), per-pair E2E encryption (R.3: the
  relay sees only a hash of the pairing code and ciphertext frames), and
  R.4's local slice (the ⧉ pair QR affordance, the phone-width layout pass,
  offline→online mid-turn resume over the relay) — all verified across all
  three tiers against the in-repo stub.
- **Also shipped (2026-07-08):** the full pre-launch gap-close block,
  **R.4b–R.4h** — a mock session is honestly labeled a demo (R.4b; its
  subscription-login-counts-as-live half was later reversed by R.4i, below); a failing `!` shell spawn
  errors only that session, never the daemon (R.4f); runaway `!` output is
  capped on the wire and in the replay ring (R.4d); the wire's additive-only
  rule is enforced with a tolerant/strict schema split and tested
  ignore-unknown on both ends (R.4h); version everywhere plus timestamped
  error mirroring and `MIRAFOLD_DEBUG=1` (R.4g); an honest "session ended,
  started a new one" notice replaces a silent URL swap, and a dead daemon
  no longer leaves a fake "still working" state (R.4c); and the artifact
  sandbox's containment properties are now proven by tests that fail when
  each defense is flipped (R.4e). Also: **R.2's code half** — the
  deployable `relay-service/` package, hardened (caps, rate limit, health
  check) and verified against the real daemon, with the "no app bundle
  served" trust decision made and documented; and three **Phase F** fidelity
  fixes — slash-command output renders (F.1), the status bar shows the
  model the engine actually resolved instead of "default"/"auto" (F.3), and
  a Gemini stderr-only failure surfaces instead of dying silently (F.4).
- **Also shipped (2026-07-10):** the **per-provider credential policy**
  (R.4i/R.4j) — one dated source of truth, `server/provider-policy.ts`,
  enforcing what each closed provider's terms permit: a Claude/Gemini
  subscription login is refused (shown `blocked` with the API-key fix, reversing
  R.4b's subscription-as-live), an OpenAI subscription runs locally but not over
  the relay, and no subscription is driven over the paid relay at all — while
  API keys and local/BYO endpoints run everywhere. Verified across all three
  tiers; docs + BUSINESS.md reconciled to match.
- **Now:** finishing **Phase R** — R.2's deploy (needs Kyle: a Fly.io
  account + a domain; the code is ready) and entitlement/billing (R.5,
  Stripe), then launch as one event: demo post, repo public, `npm publish`,
  and a purchasable Pro tier on the same day (PLAN Phase R, BUSINESS.md §9
  pivot note). True multi-user isolation (the part of 4.5 deliberately
  deferred) lands here, when viewports actually become remote.
- **Post-launch, demand-gated:** `--local` easy mode (L.2), per-session
  provider mix (L.3), push notifications, and further agent adapters as
  users ask.

Distribution intent shapes the architecture: the daemon installs globally
(`npm i -g mirafold`) and runs from **any** directory like a terminal agent
(`mirafold`, on PATH beside `claude`/`codex`/`gemini`; `npx mirafold` is
the try path), always on the user's machine. It re-skins whichever terminal
agent the user already drives (Claude Code, Codex, Gemini CLI, …); the only
hosted piece is ever a dumb WebSocket relay, and the API key never leaves the
user's machine. Two consequences follow the "your terminal agent, better face"
promise and are PLAN Phase 4 steps: the session runs in the real directory you
launched from (not a scratch workspace) with a working-dir picker and the cwd
shown at the prompt (Step 4.8 — shipped 2026-07-06), and `!` runs a **real** interactive
shell via a PTY — `sudo`/`ssh` prompts work, unlike the terminal agents' own
non-interactive `!` (Step 4.9 — shipped 2026-07-06, §2.1). Packaging to
`npm i -g` is Step 4.10 — shipped 2026-07-06 (§8); the `npm publish` itself is
the M2 launch trigger. Keep every seam agent-neutral and compatible with that.

## 11. Conventions and gotchas

- **TypeScript everywhere; yarn for everything.** One tsconfig covers both
  sides; the server runs uncompiled via `tsx`.
- **Wire protocol discipline:** add message types, never reshape existing
  ones. If you're changing an existing `WireMsg` shape, you're doing it
  wrong.
- **The trusted-shell boundary is inviolable:** nothing agent-controlled may
  render, wrap, or intercept the prompt box, the socket, or (later)
  permission prompts and pin affordances.
- **Secrets stay server-side.** Never serialize a credential into a
  `WireMsg`.
- **Comments only for non-obvious constraints** (e.g. the Origin guard's
  reasoning, the streaming-id detachment case) — the code says what it does.
- **`@protocol` alias:** declared in *both* `tsconfig.json` (for the
  compiler) and `vite.config.ts` (for the bundler). Add new shared types to
  `server/protocol.ts`; don't create a second shared module without also
  aliasing it.
- **Mock-first development:** if a UI feature can't be exercised without an
  API key, add the message flow to `MockSession` first.
- **Accepted duplication (don't consolidate on the next refactor):** the
  adapters' identical `worker()` prompt loops and listener/`emit` boilerplate
  stay duplicated — a shared base class would couple adapters that
  deliberately stand alone behind `AgentSession`, for no readability gain.
  Likewise `RenderZone`'s near-twin `render`/`artifact` upsert blocks (the
  matched key and updated fields differ; a generic helper reads worse), and
  `mock.ts`'s length (scripted demo content, not tangle). Shared logic that
  IS consolidated lives in `adapters/types.ts` (`capOutput`, `toolDetail`,
  `joinTextBlocks`) and `adapters/render-mcp-cmd.ts` (`generativeUIMsg`,
  `RENDER_ID_RE`) — decided at the 2026-07-08 refactor.
- **`dist/` is gitignored build output** served by Express; rebuild with
  `yarn build` when the front end changes and you're testing the one-port
  path.
- **PLAN.md step hygiene:** work steps in order, don't start one until the
  previous step's "Done when" is satisfied, and check items off as you go.
