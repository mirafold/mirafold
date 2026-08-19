# Mirafold glossary — the shared vocabulary

*Status:* decided. One word per thing, so we can talk about Mirafold
precisely. The "(was)" column is transition history — the old term, for anyone
who knew it.

*Context for a fresh reader:* Mirafold is a faithful browser re-skin of
terminal coding agents (Claude Code, Codex, Gemini CLI), with generative UI
layered on top. This file names its parts.

*Naming register:* plain, terminal-native compounds — mostly two words
(folder tree, diff panel, prompt box, run surface), understated, no marketing
gloss. A good one-word name is welcome when it earns its place (*shell,
paintings, decks*).

---

## The core distinction: paintings vs. decks

The most important pair, because it is the trusted-shell boundary
(agent-owned vs. shell-owned) said out loud:

- *Painting* — something the *agent* authored, via the render tools (a
  chart, a table, a diff view). Agent content. Lives in the output zone,
  pinnable.
- *Deck* — something the *shell* paints: its own live chrome (a run deck, a
  preview deck, a subagent deck). Not agent content — Mirafold's instruments.

If the agent made it, it's a painting. If the shell made it, it's a deck. Never
blur the two — that blur is exactly what the security model exists to prevent.

---

## The shell and what's in it

| Term | What it is | (was) |
|---|---|---|
| *shell* | the whole product / app | — |
| *output zone* | the main scroll where the agent's replies and paintings appear | — |
| *painting* | an agent-authored generative-UI component | "widget" |
| *deck* | a shell-owned live pane (run deck, preview deck, subagent deck) | "card" |
| *subagent deck* | the live deck a spawned subagent runs in — calm summary in the output zone, expandable to the subagent's calls and words | "subagent group" |
| *prompt box* | the input box you type into | "input box" |
| *pin dock* | where you pin live paintings to keep them in view | — |
| *status bar* | the strip showing agent → model, session status, usage | — |
| *permission bar* | the allow / deny prompt when the agent asks to act | PermBar |
| *notice line* | the dim line where the shell speaks; engine words are badged to their source | notice |
| *bang line* | inline ! shell commands run from the prompt box | — |

---

## The surfaces (the big views you switch to)

Collectively the *surfaces*. The varied suffixes (*tree / panel / view /
surface*) are deliberate — each suits the shape of its thing.

| Term | What it is | (was) |
|---|---|---|
| *folder tree* | the file browser surface | "Explorer" |
| *diff panel* | the change-review surface | "Changes" |
| *fleet view* | mission control — every live session at a glance | "fleet" |
| *run surface* | shows the real output of what the agent runs — tests, builds, running servers, web preview | (new) |

### Inside the run surface

| Term | What it is | Note |
|---|---|---|
| *run deck* | one live deck in the run surface — a test run, a build, a running server | a deck |
| *preview* | the web-rendered member — a run deck that shows the actual page | labeled "Preview"; still a deck |

---

## Sessions & connectivity

| Term | What it is | Note |
|---|---|---|
| *session* | one running agent instance | |
| *viewport* | a screen attached to a session (your laptop, your phone) | matters for later multi-user work |
| *relay* | the blind WebSocket forwarder that carries remote viewports | serves no HTML/JS, ever |
| *daemon* | the local process on the user's machine that runs the agent | internal term |
| *agent picker* | the first screen: choose an agent and a folder | (was: onboarding) |
| *backend picker* | the second step: choose which backend (local model / endpoint) | |
| *connect device* | pairing a phone or second device to the daemon via the relay | |
| *adapter* | the per-agent driver behind the AgentSession seam | internal term |

---

## The one rule to hold

*Paintings are the agent's. Decks are the shell's.* Everything else is just
labels; that one is load-bearing.
