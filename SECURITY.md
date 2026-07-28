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

**The pairing QR on screen IS the remote credential.** The connect-a-device
QR encodes the pairing code, and possession of that code is full remote
drive of the session (that's its job — the code is ~128 bits, travels only
in the URL fragment, and short pinned codes are refused). The residual is
optical, not cryptographic: anyone who can see your screen while the QR is
up — screen sharing, a recording, a photo, a meeting projector — can pair.
Treat the QR like a password field: show it only to the device you're
pairing, and relaunch the daemon (which mints a fresh code) if it may have
been captured.

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

**A repository does not get to run programs just by being browsed**
(2026-07-26 audit). Git can be told, by settings inside a repository's own
`.git/config`, to run a program during ordinary read-only commands — and the
Explorer runs `git status` automatically the moment a Files panel opens, with
no permission prompt, because it is the daemon's own call rather than an agent
tool. A repository that arrived carrying its own `.git` directory (an archive,
never a `git clone` — cloning deliberately does not copy config) could
therefore have run code the moment its folder was browsed.

Mirafold now refuses those programs by default and says so in a notice naming
what it skipped; a user who set one up deliberately can list that repo in
`trusted-repos.json` (beside the log file, path named in the notice) and it
behaves exactly as their terminal does. Specifics, each established by probing
a real repo with a marker program in every candidate setting and running the
daemon's exact commands:

- **Three settings actually execute** for the commands we issue:
  `core.fsmonitor` when it names a program (the `true` form is git's own
  builtin watcher and is left alone), and `filter.<any>.clean` /
  `filter.<any>.process`, which fire whenever git must read a file's content.
  Smudge/textconv/external-diff drivers, the signing program, pager, editor,
  ssh command, credential helper and every hook did **not** fire and are
  deliberately not neutralized. **This list is tied to the commands the daemon
  runs — adding a new git command means re-running that probe.**
- **The check asks git for the effective config**, never reads `.git/config`
  textually: a setting hidden in an `include.path` file is otherwise missed,
  and it still executes (both verified).
- **Reading the config runs nothing**, so the check itself is safe, and it is
  cached per repo and re-read when the watcher sees `.git` change.
- A repo naming more content filters than are neutralized one by one is
  refused git entirely, degrading to the plain listing rather than building an
  unbounded command line.

Pinned by `server/sessions/git-trust.itest.ts`, which plants real programs in
all three settings and fails if any of them leaves a mark on disk — verified
to fail when the protection is removed.

**One render can now carry megabytes, so the replay buffer is capped by bytes
as well as by count** (2026-07-27 audit). Each session keeps its recent
messages in memory so a reconnecting viewport can catch up. That ring was
bounded only by message COUNT, which was safe while every message was text the
agent had to type out — its own output limits were the real bound. The `image`
component broke that assumption: the agent writes a short file path and the
daemon inlines up to 2 MB of picture into a single buffered message, and
render tools are auto-allowed (they only draw), so nothing prompts. Measured
before the fix: 40 image renders retained 96 MB, and the count cap's own
ceiling worked out to roughly 10 GB. The realistic trigger is not even an
attack — an agent looping screenshot→verify renders images normally — but text
the agent picked up from somewhere untrusted could also ask for it, with no
click from the user.

The ring is now additionally bounded by `SESSION_BUFFER_MAX_BYTES` (32 MB
default), evicting oldest-first exactly as the count cap does. A single
message larger than the whole budget is still retained rather than emptying
the ring — single messages are bounded at their source (the image resolver
refuses past 2 MB). What this costs: a session that renders many large images
keeps a shorter replay history, so a viewport reconnecting after a long
absence may see a truncated head — the same degradation the count cap has
always had. Pinned by `server/sessions/registry.test.ts`, verified to fail
when the byte cap is removed.

Related, same audit: the workspace directory is a **required** argument on
both render paths (`makeRenderServer`, `generativeUIMsg`). It is what jails
the image tool's file read to the session's directory; optional, a future
adapter could omit it and silently pass the agent's own `src` through,
skipping containment and the size cap. Required, that is a compile error.

**An `exp://` link in the transcript hands the tap to Expo Go, which runs
what the link names** (2026-07-28). Agent-authored markdown may carry Expo
Go deep links (`exp://` / `exps://`) as real tappable links — that is the
mobile-app preview workflow: build the app in a session, tap the link on
your phone. Expo Go's whole job is to fetch and RUN the JavaScript bundle
at whatever address the link names, and markdown link text can always lie
about its target — so an agent steered by untrusted text it read during
the session (the same injection route disclosed for `!` output above)
could emit "tap to preview your app" pointing at an attacker's bundle.
Containment: the bundle runs inside the Expo Go app's own sandbox with
only the permissions Expo Go holds — comparable to opening a hostile web
page, which agent-authored `https://` links could always do — it takes an
explicit tap, and a phone without Expo Go installed gets nothing. The
scheme allowance is exactly `exp`/`exps`: `javascript:`, `data:`, and
every other off-allowlist scheme stays stripped, and a stripped link
renders as plain text, not a clickable dead anchor — pinned by
`web/src/registry/Md.test.ts`. The planned hardening, if mobile-app
sessions become a mainstream path, is an interstitial that reveals the
link's TRUE target before the hand-off (PLAN.md Step 4.12) — masked link
text is the deception this class of attack actually uses.
