# Security Policy

## Reporting a vulnerability

Email **security@mirafold.com**. Please don't open a public issue for
anything you believe is exploitable — email first, and we'll coordinate
disclosure timing with you.

You'll get an acknowledgment within 7 days. There is no bug bounty; fixes
credit the reporter in release notes unless you'd rather not be named.

## Supported versions

Pre-1.0: the latest published release only.

## What's most worth your attention

The trusted-shell boundary is the interesting attack surface: agent output
must never render, wrap, or intercept the prompt box, the WebSocket,
credentials, or shell-owned affordances (permission prompts, pin UI), and
raw agent HTML must never escape the sandboxed iframe. Anything that lets
model-controlled output cross that line is a vulnerability, and exactly the
kind of report we want.

## Known trust decisions (disclosed, not bugs)

**Local model servers can't be authenticated.** Mirafold discovers local
model servers (Ollama, LM Studio, vLLM, llama.cpp) by probing localhost's
well-known ports and offers what answers in the onboarding picker. A local
server has no identity to verify — anything on your machine that can bind a
free port can answer like a model server, and a session routed through an
impostor exposes the conversation (including code context) to it and lets
it steer the agent's suggestions. This is the same exposure a terminal
agent pointed at localhost has, and it requires a hostile process already
running on your machine (or another user on a shared one). On shared
machines, verify what's serving a port before picking it. Mirafold's side
of the guard: your real API keys are withheld from sessions pointed at
local servers, the browser can only ever pick endpoints the daemon itself
discovered, and the agent's permission prompts still gate consequential
actions. `MIRAFOLD_LOCAL_DISCOVERY=off` disables the probing entirely.

**A `!` command's finished output is fed to the agent.** A `!` (bang)
command's transcript is delivered to the agent as its own turn once the
command exits — that's terminal parity: the agent sees what you saw. It
also means untrusted text a command fetches (a curl'd web page, a piped
log) can try to steer the agent. The permission prompts are the backstop
for anything consequential, and the fence escaping in
`server/sessions/connection.ts` keeps command output from faking its way
out of its transcript block.

**The `.env` guard is path-based; symlinks are the accepted residual.**
The daemon denies its auto-allowed read-only tools (Read, NotebookRead,
Grep, Glob) access to its own `.env`/`.env.local` by resolved path —
direct paths, `../` traversals, and cross-cwd routes are all denied and
pinned by tests. A symlink pointing at those files is not caught. The
guard is defense-in-depth, not the boundary: creating a symlink or running
`cat .env` takes a tool that prompts (Bash, Write), so the closed routes
are the zero-click ones. A prompt-free path to the daemon's secrets is a
vulnerability we want reported.

The **Explorer's** read-only file browser (`fs_list`/`fs_listdir`/`fs_read`/
`fs_diff`, Phases E and E2) shares this same guard: it refuses
`.env`/`.env.local` *content* by basename (the file still appears in the tree —
its name isn't secret) and jails every path to the session's working directory
via realpath containment, which — unlike the tool guard above — *does* catch
symlinks that escape the root. Its read scope otherwise matches the
auto-allowed `Read` tool and `!cat` (terminal parity): any other file inside
the session directory — including a project's own `.env.production`, `id_rsa`,
etc. — is browsable, exactly as the agent could already read it. That's by
design (the browser shows you your own project); the daemon's own `.env` is
the file that's protected (2026-07-24 audit).

**Git metadata is read from the containing repo, which can sit ABOVE the
session directory** (Phase E2.3/E2.4, 2026-07-26 audit — this sharpens an
earlier, now-imprecise claim that the Explorer "can't reach outside the
session directory at all"). To show the right change letters and honor the
right ignore rules — including at a Projects-style root holding several
repos — the daemon finds the repo that contains a directory by walking
upward for a `.git`, exactly as git itself does, and that walk does not stop
at the session root. So for a session scoped to a SUBDIRECTORY of a repo,
the daemon runs `git status` in the whole repo and reads HEAD's version of a
file through that repo. Two bounds make this safe, and both are pinned by
tests:

- **No data from outside the session directory ever reaches the browser.**
  Listings contain only entries read from a jailed directory; statuses are
  attached only to those entries; a file's diff resolves only through a path
  that already passed the realpath jail. A session scoped to `repo/public`
  cannot see, name, or read `repo/TOPSECRET.txt` — verified by probe.
- **Every wire path is still jailed exactly as before.** `../`, absolute
  paths, and symlinks pointing outside the root are refused for both listing
  and diffing, even when the escape target is itself a git repo.

What this does mean: the daemon touches (reads, never writes) git metadata
for a repo your session was not scoped to, and one repo's ignore rules can
hide a file inside your scope. That is the intended fidelity — it is what
makes the file tree match what git actually thinks — but it is a real widening
of what the daemon reads compared to Phase E, so it is stated here rather
than left implied.
