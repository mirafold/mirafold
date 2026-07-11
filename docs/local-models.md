# Local models — run Mirafold with inference that never leaves your machine

**Local isn't a Mirafold feature; it's a property of the agent.** Mirafold
is a faithful re-skin of the terminal agent you already use, and it inherits
that agent's configuration untouched — so if *your agent* points at a local
inference server, your Mirafold session is fully local. There is no proxy,
no shim, and nothing genui-specific to configure: you set the agent up exactly
as you would for the terminal, and the browser skin follows.

Two of the three supported agents have a real local path today:

| Agent | Local path | How |
|---|---|---|
| **Claude Code** | ✅ Ollama (v0.14+) | Ollama speaks Anthropic's Messages API — two env vars |
| **Codex** | ✅ Ollama / LM Studio / vLLM | a custom provider in `~/.codex/config.toml` |
| **Gemini CLI** | ❌ none | the CLI only talks to Google's endpoints — no supported local path |

Both paths assume a local server that already has a model pulled. All examples
below use [Ollama](https://ollama.com); LM Studio and vLLM notes follow.

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
so onboarding shows Claude Code as live, and every token of inference stays on
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

2. Tell Mirafold the agent is configured. Mirafold decides live-vs-mock
   for Codex by looking for an `OPENAI_API_KEY` or a `codex login` — it can't
   yet see a config-file-only local provider — so give it any non-empty key:

```sh
export OPENAI_API_KEY=local
mirafold
```

The value never reaches your local server (Codex ignores OpenAI auth once
`model_provider` points elsewhere); it only flips Mirafold's "configured"
signal. This wart is scheduled to disappear in PLAN Step L.2 (`--local`
detection).

3. Verify in the terminal first if anything misbehaves: plain `codex` in the
   same directory should chat with your local model. If it does and Mirafold
   doesn't, that's a Mirafold bug — please report it.

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
degrades to a quiet warning plus the raw content as styled text (README §6.3) —
you lose the chart, never the answer. We deliberately don't gate on a curated
model list; this table is guidance from what we've seen work.

## FAQ

- **Do I need an API key at all?** No. Both paths above run with placeholder
  values; nothing is billed and no traffic leaves your machine (Path A's
  `cloud`-suffixed Ollama models are the exception — those run on Ollama's
  hosted service; avoid them if you want strictly local).
- **Can different sessions mix local and cloud?** Not yet — provider selection
  is per-daemon environment today. Per-session choice is PLAN Step L.3.
- **Why not Gemini CLI?** Google's CLI has no endpoint override for
  self-hosted servers. If that changes, it becomes one adapter config note
  here, not a new feature.

Sources: [Ollama × Claude Code](https://docs.ollama.com/api/anthropic-compatibility) ·
[Ollama × Codex](https://docs.ollama.com/integrations/codex) ·
[Codex config reference](https://developers.openai.com/codex/config-reference) ·
[LM Studio × Codex](https://lmstudio.ai/docs/integrations/codex)
