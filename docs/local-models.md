# Local models — run Mirafold with inference that never leaves your machine

**Local isn't a Mirafold feature; it's a property of the agent.** Mirafold
is a faithful re-skin of the terminal agent you already use, and it inherits
that agent's configuration untouched — so if *your agent* points at a local
inference server, your Mirafold session is fully local. There is no proxy,
no shim, and nothing genui-specific to configure: you set the agent up exactly
as you would for the terminal, and the browser skin follows.

Three of the four supported agents have a real local path today:

| Agent | Local path | How |
|---|---|---|
| **Claude Code** | ✅ Ollama (v0.14+) | Ollama speaks Anthropic's Messages API |
| **Codex** | ✅ Ollama / LM Studio / vLLM | an OpenAI-compatible provider (auto-configured, or `~/.codex/config.toml`) |
| **OpenCode** | ✅ any provider OpenCode itself supports | declare it in your own `opencode.json` (Ollama, LM Studio, OpenRouter, …); Mirafold adds nothing and the session classifies as `local` when the engine reports a local provider |
| **Gemini CLI** | ❌ none | the CLI only talks to Google's endpoints — no supported local path |

The two recipes below (Claude Code, Codex) assume a local server that already
has a model pulled. All examples use [Ollama](https://ollama.com); LM Studio
and vLLM notes follow. OpenCode needs no Mirafold-side recipe: configure it as
you would for the terminal.

---

## The zero-config path — discovery (start here)

**If your local server is running, there is nothing to configure.** The
daemon probes the well-known localhost ports at startup and while the
the agent picker is open — Ollama (11434), LM Studio (1234), vLLM (8000),
llama.cpp (8080) — and any server that answers appears in the picker with
its model list, under every agent that can drive it (Ollama under Claude
Code *and* Codex; OpenAI-dialect-only servers under Codex). Pick a model
and the session is configured automatically, per-session: Claude Code gets
the endpoint through the documented env recipe, Codex gets a custom
provider injected — no env vars, no `config.toml` edit, no dummy API key.
Start your server while the picker is open and it appears within a few
seconds, no reload.

Three knobs, all optional:

- `MIRAFOLD_LOCAL_ENDPOINTS` — comma-separated URLs to probe *in addition*
  to the well-known ports (a server on a nonstandard port).
- `MIRAFOLD_LOCAL_DISCOVERY=off` — disable the well-known-port probing
  entirely (env-listed endpoints are still honored).
- `MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS` — the outer deadline for one Codex
  turn on a discovered server (default `480000`, or eight minutes). Set it to
  `0` to disable the deadline for a model or machine that legitimately needs
  longer. This does not apply to OpenAI or to providers declared in Codex's
  own `config.toml`.

Discovery only finds a *running* server — model files on disk with no
server serving them are invisible (and unusable anyway). The two paths
below remain fully supported: they are the way to make a local endpoint an
agent's *default* (terminal parity — your terminal agent uses the same
config), and the fallback for setups discovery can't see.

---

## Path A — Claude Code against Ollama (the fastest fully-local path)

Since v0.14.0, Ollama serves [Anthropic's Messages API](https://docs.ollama.com/api/anthropic-compatibility),
so Claude Code — and therefore Mirafold's Claude Code adapter, which drives
the same engine — can run against a local model with two environment variables.

1. Install Ollama and pull a coding model (see the [model table](#choosing-a-model)
   below — the model must fit in your free RAM/VRAM; `qwen3-coder` is an 18 GB
   download that wants ~24 GB, so on a 16 GB machine pick something smaller):

```sh
ollama pull qwen3-coder
```

2. Give it the context window Claude Code needs (a derived model with a bigger
   `num_ctx` — plain user-space, no service config; see
   [context length](#choosing-a-model)):

```sh
printf 'FROM qwen3-coder\nPARAMETER num_ctx 32768\n' > /tmp/Modelfile
ollama create qwen3-coder-32k -f /tmp/Modelfile
```

3. Launch Mirafold with the Anthropic endpoint pointed at Ollama:

```sh
export ANTHROPIC_BASE_URL=http://localhost:11434
export ANTHROPIC_AUTH_TOKEN=ollama
export DEFAULT_MODEL=qwen3-coder-32k
mirafold
```

(`ANTHROPIC_AUTH_TOKEN` is required by the client but ignored by Ollama — any
non-empty value works. In a clone instead of the installed CLI, put the same
three lines in `.env` and run `yarn dev`.)

That's it. Mirafold counts a set `ANTHROPIC_BASE_URL` as "this agent is
configured" (exactly so that local setups don't fall back to the API-free mock),
so the agent picker shows Claude Code as live, and every token of inference stays on
your machine.

**Honest limitations of this path** (Ollama's, not ours): no prompt caching —
so warm multi-turn sessions re-process context and long conversations slow
down more than against the hosted API — plus no `tool_choice` and only basic
extended-thinking support.

## Path B — Codex against Ollama, LM Studio, or vLLM

Codex takes a custom, OpenAI-compatible provider in `~/.codex/config.toml`.
Two things to know first:

- Current Codex speaks **only the Responses API** (`wire_api = "responses"` is
  the only supported value; Chat Completions support was removed) — the local
  server must offer `/v1/responses`. Ollama and LM Studio do; vLLM does for
  supported models, depending on your deployment.
- Make the local provider the **top-level default** in `config.toml` (not a
  `--profile` you pass on the command line): Mirafold spawns Codex through
  its SDK and inherits your config defaults, but never passes CLI flags like
  `--oss` or `--profile`.

1. Add the provider and defaults to `~/.codex/config.toml`:

```toml
model = "qwen3-coder"
model_provider = "ollama"

[model_providers.ollama]
name = "Ollama"
base_url = "http://localhost:11434/v1"
wire_api = "responses"
```

For LM Studio, use `base_url = "http://localhost:1234/v1"`; for vLLM,
`base_url = "http://localhost:8000/v1"` (and confirm your vLLM serves the
Responses API for your model).

2. That's the whole setup — launch Mirafold. It reads the default
   `model_provider` from `~/.codex/config.toml` (honoring `CODEX_HOME`, like
   the CLI) and offers it in the agent picker as its own endpoint row — **local
   endpoint · localhost:11434** here. No key, no extra env. *(Older Mirafold
   versions couldn't see a config-file provider and needed a dummy
   `export OPENAI_API_KEY=local` to flip the "configured" signal; that wart
   is gone — an existing dummy key is harmless and can be deleted.)*

3. Verify in the terminal first if anything misbehaves: plain `codex` in the
   same directory should chat with your local model. If it does and Mirafold
   doesn't, that's a Mirafold bug — please report it.

### When a discovered Codex turn looks stuck

Codex's SDK emits an agent message only after the message item completes; it
does not expose token deltas. A CPU-bound Ollama request can therefore look
silent while Ollama pre-fills Codex's agent context, then remain silent longer
while a reasoning model thinks. Direct measurements on the ThinkPad described
below separated those two costs: the request was active in Ollama throughout,
not stalled between Mirafold and the Codex SDK.

Mirafold leaves Codex's configured reasoning default untouched. On a
probe-discovered local endpoint, `/effort` additionally offers `none`; choosing
it explicitly restarts the same warm Codex thread with reasoning disabled.
Ollama supports that Responses-API value; another local runtime may reject it,
which Codex reports as an ordinary provider error. If a discovered local turn
still does not finish within eight minutes, Mirafold ends it with a message that
names the concrete choices: use `/effort none`, choose a faster model or
machine, or raise/disable `MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS`. The limit is
outside Codex's own request retries, so one slow request cannot silently turn
into many retries before the browser becomes usable again.

## Hosted open models — the same knobs, pointed at a provider you pay

Not local — inference runs on that provider's servers and is billed to your
key there — but it's the *same mechanism* as the two paths above, so it lives
in this doc: if you've bought API access to a hosted open model, point the
agent at it exactly like a local server, with the provider's real URL and key.
Nothing subscription-shaped is involved — you pay the provider per token,
like a Claude API key.

**Claude Code** works with any Anthropic-compatible API. Two providers that
publish one:

```sh
# DeepSeek (maps claude-* model names to its own automatically)
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=sk-...        # your DeepSeek API key
mirafold
```

```sh
# Kimi (Moonshot)
export ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
export ANTHROPIC_AUTH_TOKEN=sk-...        # your Moonshot API key
export DEFAULT_MODEL=kimi-k2.7-code
mirafold
```

The agent picker shows this as **custom endpoint** (an exact-loopback URL
shows as *local endpoint* instead). The browser receives that generic label
plus an opaque daemon identifier—never the configured URL or hostname, since
URLs can contain authentication, signed queries, and private tenant/network
identity. Mirafold binds the
selected Anthropic key/token mode to this exact destination. If the endpoint
comes from project configuration, its credential must come from that same
project configuration—the endpoint cannot inherit a parent-only daemon secret.
Probe-discovered local servers always receive only Mirafold's fixed dummy
token.

**Codex** takes a hosted provider the same way as Path B — an entry in
`~/.codex/config.toml` with the provider's `base_url` and your key — with the
same constraint: Codex speaks only the Responses API, and many hosted
providers serve only Chat Completions, so confirm yours offers
`/v1/responses` before pointing Codex at it.

[OpenRouter](https://openrouter.ai) — one key for most open models behind an
OpenAI-compatible API, Responses API included — is the worked example:

```toml
model = "qwen/qwen3-coder"
model_provider = "openrouter"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
```

```sh
export OPENROUTER_API_KEY=sk-or-...    # your key, from openrouter.ai/settings/keys
mirafold
```

No `OPENAI_API_KEY` is involved: Mirafold sees the config.toml provider and
the agent picker offers it by its provider name, **OpenRouter**, without
exposing the configured base URL. The
key can also live in the `.env` where you launch Mirafold instead of an
`export` — the daemon loads it, and Codex reads whichever variable your
`env_key` names.

## Choosing a model

Local coding agents live and die on two axes: **tool-calling reliability** and
**context length**. Rough guidance, not a gate — Mirafold will run whatever
your agent runs:

| Model | Size | Needs (roughly) | Verdict for agent work |
|---|---|---|---|
| `qwen3-coder` | 30B MoE | ~24 GB VRAM (more for long context) | The recommended default — strong tool calling |
| `gpt-oss:20b` | 20B MoE | ~16 GB VRAM/unified | Good, noticeably weaker on long multi-step tasks |
| `gpt-oss:120b` | 120B MoE | ~64–80 GB (H100 / big-RAM Mac) | Excellent, if you have the hardware |
| 7–8B models | 7–8B | ~8 GB | Expect misfires — see below |

(The "needs" column assumes a GPU or Apple-Silicon unified memory. CPU-only
is a different regime — see below.)

Context length: configure **at least 32K tokens** for Claude Code, and
**64K+ for Codex** — both agents carry large system prompts and tool schemas,
and Ollama's per-model default context is far smaller, which makes the agent
truncate and behave erratically. The clean way to raise it is a **derived
model** (user-space, per-model, no service restart), as in Path A step 2:
`PARAMETER num_ctx 32768` in a two-line Modelfile. (Server-wide
`OLLAMA_CONTEXT_LENGTH=65536` also works, but on Linux that means editing the
Ollama systemd service's environment.)

**The number that gates CPU-only machines is prefill.** A faithful Claude
Code turn sends the full agent surface — system prompt, tool schemas, your
own settings and memory — before your first word: **~26K tokens, measured**.
A GPU chews through that in seconds. A CPU-only laptop we measured (ThinkPad
T480, 8 threads) prefilled ~6.5 tok/s on an 8B Q4 model — an hour before the
first reply token — and a 1.7B model completed a browser turn in ~25 minutes
end-to-end. It genuinely works (that run is this doc's verification), but
it's proof, not daily driving: on CPU-only hardware treat local Claude Code
as an experiment with small models, and use a ≥16–24 GB GPU for real work.
(Slow prefill can also outlive a client's stream timeout and get retried;
Ollama's prompt prefix cache makes each retry resume where the last stopped,
so long prefills still converge.)

**What "degrades gracefully" means here.** Mirafold's generative UI rides on
the agent's own tool calling (MCP). Big coding models use the `render_*` tools
well; small or unusual models may call them with malformed arguments, loop, or
ignore them. Mirafold is built for that: a malformed render instruction
degrades to a quiet warning plus the raw content as styled text
([ARCHITECTURE.md](ARCHITECTURE.md#generative-ui)) —
you lose the chart, never the answer. We deliberately don't gate on a curated
model list; this table is guidance from what we've seen work.

## FAQ

- **Do I need an API key at all?** No. Both paths above run with placeholder
  values; nothing is billed and no traffic leaves your machine (Path A's
  `cloud`-suffixed Ollama models are the exception — those run on Ollama's
  hosted service; avoid them if you want strictly local).
- **Can different sessions mix local and cloud?** Yes — the backend is chosen
  per session in the agent picker (a discovered local server, a configured provider,
  or a cloud credential), and each session keeps its choice across restarts.
- **Why not Gemini CLI?** Google's CLI has no endpoint override for
  self-hosted servers. If that changes, it becomes one adapter config note
  here, not a new feature.

Sources: [Ollama × Claude Code](https://docs.ollama.com/api/anthropic-compatibility) ·
[Ollama × Codex](https://docs.ollama.com/integrations/codex) ·
[Codex config reference](https://developers.openai.com/codex/config-reference) ·
[LM Studio × Codex](https://lmstudio.ai/docs/integrations/codex) ·
[DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api/) ·
[Kimi × Claude Code](https://platform.kimi.ai/docs/guide/agent-support)
