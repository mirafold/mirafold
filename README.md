# Mirafold

**Mirafold is a browser interface for the terminal coding agent you already
use—Claude Code, Codex, OpenCode, or Gemini CLI—with generative UI layered on
top.** The agent still runs on your machine with its own engine, credentials,
configuration, and permission model.

> Mirafold is in public beta. Bug reports and rough edges are welcome in the
> [issue tracker](https://github.com/mirafold/mirafold/issues).

![Mirafold showing a repository overview, a test-and-fix turn, an interactive shell command, and a pinned chart](demo/demo.gif)

## Highlights

- Faithful integrations with Claude Code, Codex, OpenCode, and Gemini CLI—one
  adapter per agent, with no generic replacement agent in the middle.
- Streamed markdown plus live tables, charts, diffs, task lists, diagrams,
  images, and other interactive components generated through Model Context
  Protocol (MCP) tools.
- Persistent sessions, multiple attached browser views, and a mission-control
  view for supervising several sessions at once.
- Read-only workspace browsing and Git change review beside the conversation.
- A real pseudo-terminal (PTY) for `!` commands, including interactive
  programs and password prompts, inside shell-owned UI.
- Optional remote browser and phone access through an end-to-end-encrypted
  relay; provider credentials remain on the machine running Mirafold.

Mirafold drives a real coding agent with access to your filesystem and shell.
Review permission prompts, use it only in directories you are prepared to give
an agent access to, and read the [security policy](SECURITY.md) before exposing
or pairing a session.

## Install

Mirafold requires Node.js 22 or newer.

Install it globally, move into the project you want the agent to work in, and
start the daemon:

```sh
npm install --global mirafold
mirafold
```

The command binds a local server to loopback, opens the browser, and uses the
current directory as the default workspace. Useful launcher options:

```sh
mirafold --help
mirafold --no-open
mirafold --verbose
```

Use `npx mirafold` only inside a project you already trust: npm exposes
project-local executables to commands launched through `npx`. The global
install avoids that package-shadowing path; it does not make an unfamiliar
checkout safe.

## First run

Onboarding asks for a supported agent, one of its detected backends, and a
working directory. Mirafold uses the selected agent's native engine and any
supported authentication it detects. If no usable live backend is available,
the session runs the built-in scripted demo so the entire interface can be
explored without model traffic.

Optional Mirafold settings are documented in [.env.example](.env.example) and
summarized by `mirafold --help`. Local and hosted open-model setups are covered
in [docs/local-models.md](docs/local-models.md).

Inside a session:

- Type ordinary prompts in the command box.
- Prefix a command with `!` to run it in Mirafold's interactive shell.
- Open `/` for mission control and `/s/<session-id>` for a session viewport.
- Use the Files and Changes workspaces to inspect the current directory and
  its Git working-tree changes.

## Development

The repository is one TypeScript package. It uses Yarn 1.22.22 and requires
Node.js 22 or newer.

```sh
git clone https://github.com/mirafold/mirafold.git
cd mirafold
corepack enable
yarn install
yarn dev
```

Open [http://localhost:5173](http://localhost:5173). The Vite development
server proxies the local daemon, and a credential-free agent choice uses the
scripted demo backend.

Build and exercise the packaged path with:

```sh
yarn build
node bin/mirafold.js
```

The main verification commands are:

| Command | What it checks |
| --- | --- |
| `yarn typecheck` | TypeScript across the server, web client, and tests |
| `yarn test` | Unit tests |
| `yarn test:server` | Real daemon and WebSocket integration tests using mock agents |
| `yarn test:e2e` | Production build and end-to-end browser tests |
| `yarn test:ui` | Managed-browser compatibility and visual baselines |
| `yarn test:live` | Opt-in tests against installed agent binaries and local models |

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules and the required
test tier for a change.

## Architecture

The local daemon adapts each agent's native event stream into the shared
protocol in [`server/protocol.ts`](server/protocol.ts). A session registry owns
the warm agent sessions, replay history, and browser attachments. The React
client keeps shell-owned controls separate from the agent-controlled output
zone, where validated registry components and sandboxed artifacts render.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system model, core
contracts, trust boundaries, key flows, and repository map. Adapter authors
should also read the normative [adapter specification](docs/ADAPTERS.md).

## Documentation

| Document | Purpose |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Runtime structure, contracts, flows, and constraints |
| [Adapter specification](docs/ADAPTERS.md) | Requirements and checklist for agent integrations |
| [Local models](docs/local-models.md) | Ollama, LM Studio, vLLM, and compatible hosted providers |
| [Security policy](SECURITY.md) | Safe operation, disclosure process, and known trust decisions |
| [Contributing](CONTRIBUTING.md) | Developer Certificate of Origin sign-off and verification expectations |
| [Glossary](GLOSSARY.md) | Shared product and interface vocabulary |
| [Plan](PLAN.md) | Current work and roadmap; completed history is in [PLAN-ARCHIVE.md](PLAN-ARCHIVE.md) |
| [Release guide](docs/RELEASING.md) | Branching and release procedure |

## License

Mirafold's own code is licensed under the [MIT License](LICENSE). Integrated
agent engines and third-party packages retain their own licenses; bundled web
dependencies are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Claude Code, Codex, OpenCode, and Gemini CLI are trademarks of their respective
owners. Mirafold is not affiliated with or endorsed by Anthropic, OpenAI, the
OpenCode project, or Google.
