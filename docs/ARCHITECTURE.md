# Mirafold architecture

Mirafold is a local Node.js daemon plus a React browser client. It wraps
supported terminal coding agents without replacing their engines: each agent
runs through its own adapter, while the rest of Mirafold consumes one shared
message protocol.

This document is the ownership-level map of the shipped system. Source files
remain authoritative, and [ADAPTERS.md](ADAPTERS.md) is the normative contract
for adding or changing an agent integration.

## System model

```mermaid
flowchart LR
    Engine[Terminal agent engine] --> Adapter[Agent adapter]
    Engine -->|calls| MCP[Model Context Protocol render tools]
    MCP --> Adapter
    Adapter -->|WireMsg| Registry[Session registry]
    Registry --> Local[Local WebSocket viewport]
    Registry -->|encrypted frames| Relay[Optional relay]
    Relay --> Remote[Remote viewport]
    Local --> Shell[Trusted browser shell]
    Remote --> Shell
    Shell --> Output[Agent-controlled output zone]
```

Four rules define the shape:

1. **Each agent keeps its own engine.** Claude Code, Codex, Gemini CLI, and
   OpenCode are independent adapters behind the same `AgentSession` interface.
2. **The wire protocol is the shared contract.** Adapters emit `WireMsg`; the
   session layer and browser do not consume provider-native events.
3. **A session is not a connection.** The daemon owns sessions, replay history,
   checkpoints, and agent lifecycle. A browser connection is a viewport that
   attaches to one session.
4. **The browser has a hard trust boundary.** Shell controls are application
   owned. Agent-authored content can render only in the output zone.

## Runtime structure

### Launcher and local daemon

[`bin/mirafold.js`](../bin/mirafold.js) runs the packaged daemon from the
current directory and opens the authenticated local URL once the server is
listening. [`server/index.ts`](../server/index.ts) is the daemon entry point:
it serves the built client, hosts the `/ws` WebSocket endpoint, binds to
`127.0.0.1`, applies the launch-token and Origin checks, creates the session
registry, and optionally dials the relay.

The daemon delegates by responsibility:

- [`server/adapters/`](../server/adapters/) drives agent engines and normalizes
  their output.
- [`server/sessions/`](../server/sessions/) owns session lifecycle,
  connections, checkpoints, filesystem requests, Git inspection, uploads, and
  component actions.
- [`server/security/`](../server/security/) owns local authentication,
  executable trust, and tool-permission policy.
- [`server/pty/`](../server/pty/) owns the interactive `!` pseudo-terminal
  (PTY) shell.
- [`server/relay/`](../server/relay/) owns pairing, encryption, the daemon's
  outbound relay client, and its transport contract.

The server is bundled to `dist-server/` for the published package. The browser
bundle is emitted to `dist/` and served by the same daemon outside development.

### Agent adapters

[`AgentSession`](../server/adapters/types.ts) is the provider-neutral seam. Its
core responsibilities are to accept prompts, emit normalized messages,
interrupt an in-flight turn, resolve supported permission requests, expose
model and durable conversation identity, refresh provider-owned prompt
options, and close cleanly. Some engines also publish backend classification
after startup because the truthful provider cannot be known before the engine
is running.

The shipped implementations are:

| Adapter | Engine surface |
| --- | --- |
| [`claude-code.ts`](../server/adapters/claude-code.ts) | Anthropic Agent SDK |
| [`codex.ts`](../server/adapters/codex.ts) | OpenAI Codex SDK and Codex CLI |
| [`gemini-cli.ts`](../server/adapters/gemini-cli.ts) | Gemini CLI headless stream |
| [`opencode.ts`](../server/adapters/opencode.ts) | Per-session `opencode serve` HTTP and event stream |
| [`mock.ts`](../server/adapters/mock.ts) | Scripted, model-free development and test backend |

[`server/adapters/index.ts`](../server/adapters/index.ts) detects available
backends, applies provider policy, validates a browser's backend choice, and is
the one place that constructs a concrete adapter. Shared code does not branch
on provider-specific events after this seam.

Gemini is the one shipped adapter with a project-settings write. Its headless
surface loads MCP servers from project settings, so the adapter may create
`<workspace>/.gemini/settings.json` when that file is absent. It does not open
or modify a pre-existing file before the user grants workspace trust; after
trust, it merges the Mirafold MCP entry into the existing settings.

See [ADAPTERS.md](ADAPTERS.md) for event grammar, capability differences,
credential constraints, MCP requirements, and the add-an-adapter checklist.

### Session registry and connections

[`SessionRegistry`](../server/sessions/registry.ts) owns active and dormant
sessions. Each entry contains the adapter, working directory, attached local
and remote viewports, sequenced replay buffer, prompt catalog, usage, pending
permissions, and lifecycle state.

[`connection.ts`](../server/sessions/connection.ts) is the transport-neutral
message boundary used by local WebSockets and relay viewports. It validates
client messages, attaches or creates a session, routes prompts and shell
actions, and sends per-viewport replies. Session broadcasts are sequenced and
fanned out to every attached viewport.

[`session-store.ts`](../server/sessions/session-store.ts) writes bounded,
owner-only checkpoints and strictly validates them before recovery. A closed
tab detaches its viewport; it does not end the session. An idle active engine
can unload while the checkpoint remains available for lazy recovery.

### Browser client

[`web/src/main.tsx`](../web/src/main.tsx) has two routes:

- `/` mounts [`FleetView`](../web/src/components/FleetView.tsx), the
  mission-control view.
- `/s/<session-id>` mounts [`Shell`](../web/src/components/Shell.tsx), one
  session viewport.

[`session-bus.ts`](../web/src/session-bus.ts) owns one
[`SocketClient`](../web/src/ws.ts) and fans incoming messages to shell
consumers. `Shell` owns connection state, onboarding, the prompt, permission
and terminal-input bars, status, workspace panels, settings, notifications,
and other trusted controls.

[`FilesPanel.tsx`](../web/src/components/files/FilesPanel.tsx) owns the lazy
workspace tree and the phone drill-in. On desktop, its primary file action
opens [`FilePaneRegion.tsx`](../web/src/components/files/FilePaneRegion.tsx),
whose tabs each own an independent `useFileView` request controller; correlated
replies therefore cannot paint the wrong tab. These are shell-owned,
viewport-local surfaces and never enter transcript replay.

[`RenderZone.tsx`](../web/src/components/RenderZone.tsx) receives the transcript
stream. Pure projection code converts wire messages into ordered transcript
rows, groups eligible rows into response documents, and keeps provider-native
tool activity, errors, and shell boundaries visible. The output zone delegates
structured content to [`web/src/registry/`](../web/src/registry/) and arbitrary
HTML to the sandboxed [`Artifact`](../web/src/components/Artifact.tsx) host.

### Generative UI

Mirafold exposes drawing tools to each agent through the Model Context Protocol
(MCP). Claude Code uses the in-process server in
[`render-tools.ts`](../server/render-tools.ts); adapters that load an MCP
subprocess use [`render-mcp.ts`](../server/render-mcp.ts).
Both paths use the schemas in
[`registry-spec.ts`](../server/registry-spec.ts).

A normal render call produces a `render` message containing a component name,
validated props, and an id. Calling again with the same id updates the existing
component in place. The browser validates the props again before mounting the
React component. Unknown components and malformed props degrade without
taking down the session.

When no registry component can express the result, an agent may emit an HTML
artifact. Artifacts are the only raw agent HTML path and run inside a
network-blocked, opaque-origin iframe. Their actions cross a narrow,
nonce-validated bridge and re-enter the same server mediation used by registry
components.

## Core contracts

### Wire protocol

[`server/protocol.ts`](../server/protocol.ts) defines both directions of the
browser/server protocol:

- `WireMsg` covers streamed text and reasoning, tool activity, renders,
  artifacts, shell status, session metadata, filesystem replies, PTY output,
  fleet snapshots, and lifecycle events.
- `ClientMsg` covers prompts, interrupts, permission answers, session
  attachment and creation, mediated component actions, PTY input, filesystem
  requests, uploads, and fleet actions.

The protocol is **additive**: add a new message type or optional field; do not
reshape an existing message. Both ends ignore unknown message types, and
broadcast messages carry session-local sequence numbers so reconnecting
clients can request only the unseen tail. Replayed messages are marked so the
client can reproduce state without repeating live-only side effects.

### `AgentSession`

Every real adapter must preserve its provider's own behavior while satisfying
the normalized session contract. In particular:

- Prompts submitted during a turn are queued rather than lost or interleaved.
- Provider output retains useful native ordering and always has a discernible
  `turn_end` boundary.
- Interrupt leaves the session usable for another prompt.
- Durable provider conversation identity is exposed when the engine makes it
  available.
- Unsupported capabilities are omitted instead of simulated in shared code.
- Provider-native values that enter trusted shell chrome are visibly
  attributed when required.

The exact requirements live in [ADAPTERS.md](ADAPTERS.md); this overview does
not replace them.

## Trust boundaries

The trusted-shell boundary is the central security invariant:

```text
trusted shell: prompt · socket · permissions · PTY input · status · pins
------------------------- trust boundary -------------------------------
agent output: markdown · tool records · registry components · artifacts
```

- Provider credentials and configured endpoint URLs stay in the daemon. They
  are not serialized into browser messages.
- Agent output cannot render, wrap, or intercept the prompt, socket,
  permission controls, terminal input, status, or pin affordances.
- Markdown is rendered without raw HTML. Agent-authored HTML is confined to
  the sandboxed artifact iframe.
- Consequential agent tools follow provider permission policy and deny by
  default when an outstanding prompt times out or is interrupted.
- Component tool actions are allowlisted and validated on the server. A
  component cannot make an arbitrary client-side call.
- Local HTTP and WebSocket traffic is bound to loopback. With authentication
  enabled, both require the launch token; browser WebSockets also pass the
  Origin check.
- Remote viewports arrive through an outbound daemon connection. Session
  content is end-to-end encrypted; the relay still observes ordinary
  forwarding metadata such as connection timing and byte counts.
- The workspace browser is jailed to the selected working directory, but the
  agent and the `!` PTY are real local processes with the user's privileges.
  They are not sandboxes.

[SECURITY.md](../SECURITY.md) documents safe operation, disclosure, and the
accepted residual risks in detail.

## Key flows

### Launch and create a session

1. The launcher starts the daemon in the current directory and waits for its
   authenticated URL.
2. The browser connects and receives the available agents, backend choices,
   default directory, and daemon capabilities.
3. Onboarding submits a validated agent, backend, and existing directory.
4. The registry creates an entry and `adapters/index.ts` constructs the chosen
   real adapter or the scripted mock.
5. The browser receives `session_created`, adopts `/s/<id>`, and attaches as a
   viewport.

### Run one turn

1. `PromptBox` sends a `prompt` through the session bus.
2. The connection broadcasts the corresponding `user_prompt` and passes the
   text to `AgentSession.pushPrompt()`.
3. The adapter drives its engine and normalizes native events into sequenced
   `WireMsg` records.
4. The registry buffers, checkpoints, and broadcasts the records to every
   viewport.
5. The browser projects the stream into transcript rows and response
   documents. A final `turn_end` settles activity and clears busy state while
   the provider conversation remains resumable.

### Render and act on a component

1. The agent calls a Mirafold MCP render tool with schema-checked props.
2. The adapter emits a `render` message at that exact point in the native
   event stream.
3. The client validates the props again and mounts or updates the component.
4. A component interaction becomes a typed `action` carrying its render id.
5. The server validates and mediates the action, then broadcasts any visible
   result back through the ordinary session stream.

### Reconnect or attach another viewport

1. The client attaches with the last sequence number it observed.
2. If that cursor remains in the bounded buffer, the registry replays only the
   unseen tail; otherwise it sends a complete available replay.
3. A second local tab follows the same path. A paired remote browser uses the
   same connection logic after the relay layer authenticates and decrypts its
   frames.

## Repository map

| Path | Responsibility |
| --- | --- |
| `bin/` | Installed launcher and trusted browser opener |
| `server/index.ts` | Daemon entry point, HTTP/WebSocket server, relay startup |
| `server/protocol.ts` | Shared browser/server protocol |
| `server/adapters/` | Agent integrations and the `AgentSession` seam |
| `server/sessions/` | Session, connection, persistence, workspace, Git, upload, and action logic |
| `server/security/` | Authentication, tool permissions, and executable trust |
| `server/pty/` | Interactive `!` shell |
| `server/relay/` | Pairing, encryption, and outbound remote transport |
| `server/testing/` | Integration, browser, visual, and live-test infrastructure |
| `web/src/components/` | Trusted shell and session/fleet surfaces |
| `web/src/registry/` | Agent-paintable React component vocabulary |
| `web/src/styles/` | Structural styles by surface |
| `web/src/themes/` | Theme palettes and token manifest |
| `docs/` | Architecture, adapters, local models, release process, and feature specifications |

Tests live beside their source. Suffixes select the tier: `*.test.ts` for
unit tests, `*.itest.ts` for daemon integration, `*.e2e.ts` for browser end to
end, `*.uitest.ts` for managed-browser and visual checks, and `*.ltest.ts` for
opt-in live-agent tests.

## Standing constraints

- TypeScript spans the server and browser in one Yarn package.
- Shared server/browser modules require matching aliases in both
  `tsconfig.json` and `vite.config.ts`.
- Shared code stays agent-neutral; provider-specific behavior belongs in its
  adapter.
- The wire protocol only grows additively.
- The trusted-shell boundary is not relaxed for convenience.
- UI work is exercised against the mock before a live model is involved.
- The visual language is a terminal workbench, not a chat application:
  monospace command input, rich output, no message bubbles, and
  provider-native activity that compacts only after it settles.
- Some duplication is deliberate. Adapter worker/listener boilerplate stays
  local to each adapter so their lifecycles remain independent; the distinct
  render/artifact update paths and the scripted mock are not genericized only
  to reduce line count.

Current work belongs in [PLAN.md](../PLAN.md), completed history in
[PLAN-ARCHIVE.md](../PLAN-ARCHIVE.md), and decided product terms in
[GLOSSARY.md](../GLOSSARY.md). Do not duplicate roadmap status here.
