# genui-shell — Business Plan

*Drafted 2026-07-04. Companion to PLAN.md (the build plan). This document is
the honest version — assumptions are labeled, risks are ranked, and the
financial scenarios include the failure case.*

*Readable HTML mirror (redeployed on each revision):
https://claude.ai/code/artifact/42d3599e-570e-427e-ae4b-0df4e6577a53*

---

## 1. One-liner

**The cockpit for people who live in terminal agents.** A generative-UI shell
where the agent's output is a live, paintable dashboard — pin what matters,
watch it update, supervise from anywhere — while the full agentic engine
(bash, filesystem, warm sessions) runs untouched underneath.

## 2. The customer

**Beachhead:** developers who already run terminal agents (Claude Code,
Codex CLI, etc.) daily and profitably. Characteristics:

- Already pay for Max plans / burn API credit without flinching. Price
  sensitivity is low; *taste* sensitivity is high.
- Their pain is not the transcript — it's **supervision**: long-running
  turns, multiple concurrent sessions, no ambient view of state, no way to
  check on an agent from the couch or phone.
- They are terminal-native and allergic to toy UIs. The product must signal
  terminal lineage (PLAN.md's design identity section already locks this).

Estimated reachable population: tens of thousands today, growing fast.
Realistic capture at indie scale: hundreds to low thousands of paying users.
This is a niche business by design — see §8 (Risks).

**Not the customer (yet):** teams, enterprises, no-code users. Multi-user is
an architectural seam (PLAN Phase 4.5), not a launch goal.

## 3. The wedge (sequenced, not simultaneous)

The strategic insight: coding *editing* is a crowded UI market (Cursor, IDEs,
Claude Code itself). Coding *supervision* and non-coding agent work have no
incumbent UI. Enter through the door nobody guards.

**Wedge 1 — Mission control for your agents (launch wedge).**
Same audience, unserved job. Power users increasingly run several
sessions/loops/cron agents at once. genui-shell's primitives map exactly:
multi-session (Phase 4.2) + pin dock (Phase 1.6) + live re-render-by-id =
a fleet view where each agent's status, current task, and key outputs are
pinned, live widgets (PLAN Steps 4.2 + 4.6). The phone/tablet view of this
(via the relay, §5 / PLAN 4.7) is
the single most demoable, most tweetable capability: *"watching my agent
finish a refactor from the couch."* No terminal can do this.

**Wedge 2 — Ephemeral ops dashboards (expansion).**
The agent tails a deploy, watches CI, greps logs — and paints a one-off
dashboard for *this incident*, which dissolves when unpinned. Grafana is for
dashboards you keep; this is for dashboards you'd never bother to build.
Same audience again (devs wear the ops hat), zero new distribution needed.

**Wedge 3 — General agent workbench (the long game).**
Data analysis, personal automation, research — domains where the agent loop
is valuable but the terminal actively repels the user. The architecture is
already domain-agnostic (registry components are just components). Only
pursue after wedges 1–2 prove the engine; this is where the market stops
being a niche, and also where big-platform competition is hottest.

**Explicit non-goal:** competing with IDEs on code editing/diff review.
Link out to the user's editor; don't rebuild it.

## 4. Differentiation & moat

Ranked by durability (least → most durable):

1. **First-mover on genUI-over-agent** — real but expiring. Worth weeks-to-
   months of recognition, not a moat. Cash it in at launch (§6).
2. **Taste** — the mono-in/rich-out identity, the pin-dock interaction, the
   restraint of registry-first. Big platforms ship lowest-common-denominator
   UI; a niche tool can be opinionated. This is the actual product bet.
3. **Trusted-shell security model** — agent-controlled UI that provably can't
   spoof the prompt box or touch credentials. As prompt-injection attacks on
   agent UIs become news, this becomes marketing, not just engineering.
4. **Local-first trust** — your code and API key never leave your machine
   (§5), and from M2, neither does your inference: local-model support
   (PLAN Phase L) completes the story as "fully local, down to the model."
   The platforms' hosted offerings can't match this posture — Anthropic's
   front ends will never route to Llama — so it's the one structural
   advantage an indie has over them, and local support deepens it rather
   than diluting focus.

## 5. Delivery architecture — the answer to "don't I have to host it?"

**No. Selling on a website ≠ running the workload on your website.**
The product splits into three pieces with very different costs:

```
┌─ marketing site + account/billing ── hosted by you (static + Stripe; ~$0)
├─ the shell UI ───────────────────── static files; hosted by you (~$0)
└─ the engine (agent, bash, files) ── runs on the USER'S machine
```

**Ship as: `npx genui-shell` (or `brew install`).** One command starts the
local daemon (the existing `server/`) and opens the UI. Two modes:

- **Free/local:** UI served from localhost. Full product, single machine.
  This is the open-core distribution engine (§6).
- **Paid/connected:** the daemon pairs with your hosted **relay** (PLAN
  Step 4.7) — a thin WebSocket forwarder (the wire protocol is already the
  seam: once the session registry lands (PLAN 4.2), the relay is just
  another attached viewport; the relay
  never sees the API key, which stays in the local daemon per PLAN's
  security model — though note it does see message *content*, so E2E-encrypt
  the tunnel per-pair). This unlocks: access your sessions from any browser
  or phone, push notifications on turn-end/permission-request, session
  persistence/sync, share-a-session links.

The paid tier is therefore **pure convenience infrastructure** — cheap to
run (a relay pushes bytes; it doesn't run agents), high perceived value
(phone access is wedge 1's killer demo), and it never puts you in the
sandboxed-compute or key-reselling business.

**Deferred, explicitly:** hosted execution (you run the agent in cloud
sandboxes). Revisit only if demand is proven and funded — it's a different
company. **Rejected:** fronting API keys under a flat fee (unbounded margin
risk, abuse magnet, ToS exposure). If key-fronting ever happens it is
metered passthrough with hard caps, nothing else.

## 6. Go-to-market

Recognition-first, because first-mover value expires (§4.1):

1. **The demo is the marketing.** A 30-second GIF: agent working; user pins
   a live test-status widget and a chart; keeps prompting; widgets update;
   cut to the same session on a phone. Every launch asset derives from this.
2. **Open-core.** OSS the shell + local daemon (MIT or BSL — decide before
   launch; BSL if worried about a hosted clone). Rationale: (a) the stated
   goal is *recognition* — OSS on HN/GitHub is the only reliable indie
   distribution channel; (b) it converts would-be clones into contributors;
   (c) the paid relay is naturally closed. Cost: someone can self-host a
   relay. Accept it; self-hosters were never customers.
3. **Launch sequence:** demo GIF on X → Show HN → r/ClaudeAI, agent-tooling
   Discords → a "how the trusted-shell security model works" writeup (the
   security angle earns a second, distinct news cycle among exactly the
   right audience). The M2 launch ships with local-model support documented
   (PLAN L.1) so the headline reads **"BYOK or fully local — your code,
   your key, and your model never leave your machine"** — this also opens
   r/LocalLLaMA as a second distribution channel and pre-empts "does it
   work with Ollama?" as the top comment. Claude stays the demo/default;
   local is a documented path, not the first impression.
4. **Ongoing:** each PLAN phase completion is a launchable moment (pin dock,
   actions, artifacts, mobile relay). Ship loudly, monthly.

## 7. Business model & pricing

- **Free (OSS):** full local product, BYOK. This is distribution, not
  charity — every free user is a demo-GIF amplifier and a conversion lead.
- **Pro — $12/mo or $99/yr:** relay access (any device), push notifications,
  session sync/persistence, share links, priority support. Price anchored
  against what this audience already spends ($20–200/mo on model access)
  — $12 is an impulse add-on for them.
- **Later, maybe:** team tier (shared sessions, SSO) if pull emerges.
- **Never (at this stage):** flat-fee bundled API usage.

Costs: relay + site + auth/billing ≈ $20–100/mo at launch scale. Model
costs: $0 (BYOK). Break-even at ~5–10 subscribers; this business is
structurally profitable almost immediately or it's dead — a clean signal.

## 8. Risks, ranked

1. **Platform risk (severe, unchanged).** Anthropic/OpenAI/Cursor ship genUI
   agent shells natively. *Mitigation:* speed (§9 gates), niche taste they
   won't match, local-first posture they structurally can't match, and the
   honest acknowledgment that this caps the outcome at "beloved niche tool,"
   which is the plan anyway.
2. **Demand risk.** Passionate terminal users might be passionate *about the
   terminal* — supervision pain may be tolerated, not paid for. *Mitigation:*
   validation gates (§9) before any billing code is written.
3. **Free-rider risk.** OSS local product is good enough; nobody pays for the
   relay. *Mitigation:* phone access + notifications are genuinely hard to
   self-host well; if conversion is still ~0%, the relay was the wrong paid
   surface — pivot the paid tier, keep the audience.
4. **Solo-founder bandwidth.** PLAN.md has ~20 open steps; wedge 1 adds
   relay + mobile + notifications. *Mitigation:* the sequencing in §9 cuts
   scope to a launchable core; everything else waits.
5. **SDK/ToS drift.** The Agent SDK's key requirements, subscription-auth
   rules, or rate structures change under you. *Mitigation:* BYOK keeps you
   out of the blast radius of most pricing changes; wire-protocol seam keeps
   you portable if the SDK shifts.

## 9. Milestones & validation gates

Each gate is a go/no-go with a measurable signal. Do not pass a gate on hope.

- **M0 — Engine live. ✅ PASSED 2026-07-04.** PLAN 0.3/0.7 verified with a
  real key (live smoke: warm multi-turn, workspace file ops, reconnect).
- **M1 — The demo exists. ← IN PROGRESS.** PLAN 1.1–1.3 + 1.6 (render
  protocol → registry → pin dock). 1.1–1.3 shipped 2026-07-04 — the live
  agent already answers with real components unprompted. Remaining: 1.6,
  then 1.4 (render fallback — required before anything goes public), then
  record the GIF. *Gate:* the GIF makes a stranger say "want."
  Post it before building anything else. **Signal: ≥ a few hundred genuine
  reactions / ≥ 50 GitHub stars in week one.** If flat: the thesis needs
  work — iterate the demo, not the infra.
- **M2 — OSS launch.** Repo public, `npx genui-shell` works cold on a
  stranger's machine, local-model path documented (PLAN L.1; optional
  feasibility spike L.0 any time earlier), Show HN with the "BYOK or fully
  local" headline. *Signal: ≥ 300 stars, ≥ 20 people you don't know running
  it (telemetry-free proxy: issues/discussions from strangers).* Local-setup
  friction in the issue tracker is the demand signal that gates the
  `--local` easy mode (PLAN L.2).
- **M3 — Paid relay.** Build the session registry if not yet done (PLAN
  4.2), then relay + pairing + phone view + notifications (PLAN 4.7).
  *Signal: ≥ 25 paying subscribers in 60 days (~$300 MRR).* If M2 passed but
  M3 fails, audience is real & paid surface is wrong — pivot tier, not product.
- **M4 — Wedge 2 (ops dashboards) + Phase 2 actions.** Interactive pinned
  widgets. *Signal: retention — do M3 subscribers still use it weekly?*
- **M5 — Decide the long game.** With real usage data: deepen the niche
  (lifestyle business), pursue wedge 3 (raise or fund from revenue), or
  fold the learnings into the next thing. All three are wins from here.

## 10. Financial scenarios (honest)

- **Downside (~40%):** M1 demo lands flat or M2 fizzles. Revenue ≈ $0.
  Yield: a strong OSS artifact and proof-of-work on the field's most visible
  UX problem — career leverage, not income.
- **Base (~45%):** niche traction. 300–1,500 subscribers over 18 months →
  **$3k–15k MRR**, near-zero costs. A real indie business; not quit-your-
  job money at the low end, meaningful at the high end.
- **Upside (~15%):** wedge 1 demo goes genuinely viral pre-platform-response
  and wedge 3 opens. 5k+ subscribers / acqui-hire interest / a fundable
  company. Real, but do not plan spending around it.

*(Probabilities are gut-calibrated priors, not data. M1/M2 signals replace
them with data — that's what the gates are for.)*

## 11. Immediate next actions (refreshed 2026-07-04)

1. ~~Put a real `ANTHROPIC_API_KEY` in `.env`; close PLAN 0.3 + 0.7.~~ Done.
2. ~~Build PLAN 1.1 → 1.3.~~ Done. Next: **1.6 (pin dock) → 1.4 (fallback)**.
   Skip Phase T until after the GIF exists; 1.4 ships before anything public.
3. Record the demo GIF. Show it to strangers. Read §9-M1 before doing
   anything else on this list.
4. Decide the license (MIT vs BSL) and name-check the npm package name now
   (`genui-shell` availability), before someone else squats it.
   *Name-check done 2026-07-04: `genui-shell` is unclaimed on npm (registry
   404). License decision still open.*

**Measured velocity (2026-07-04):** M0 closeout + PLAN 1.1–1.3, verified and
pushed, in one working day (~5–6 plan steps/day). Half-pace projections
against the gates: M1 demo in hand ≈ 1–2 working days; M2-launchable
(Phase T + 4.1/4.2 + packaging + L.1) ≈ one further week; M3 build ≈ 2–3
weeks but sequenced by the M1/M2 signal windows, not by code — calendar to
first revenue is realistically 6–10 weeks and gated on audience signal.
