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

**Beachhead:** developers who already run terminal agents daily and profitably
— **whichever agent they use** (Claude Code, Codex, Gemini CLI, one on a local
model, …). genui-shell faithfully re-skins whatever terminal agent they already
use (§4.5, PLAN Phase P), so the beachhead is not "Claude users" but "anyone
living in a terminal agent, whichever one." Characteristics:

- Already pay for Max plans / burn API credit without flinching. Price
  sensitivity is low; *taste* sensitivity is high.
- Their pain is not the transcript — it's **supervision**: long-running
  turns, multiple concurrent sessions, no ambient view of state, no way to
  check on an agent from the couch or phone.
- They are terminal-native and allergic to toy UIs. The product must signal
  terminal lineage (PLAN.md's design identity section already locks this).

**First target inside the beachhead (added 2026-07-08):** the API-key-by-
conviction cohort — people with enough money and desire for terminal agents
that they already run on a metered API key and **reject subscriptions
specifically because they refuse arbitrary limits mid-work**. They spend many
hours a day, often all day, in coding agents, and they work from multiple
devices. Why they're first, not just included:

- They have already revealed the exact preference we sell to: they pay a
  premium (metered API over a capped plan) for *the absence of friction while
  working*. An extra $12/mo for the same work to look much better and do more
  is nothing to them — noise against their monthly model spend.
- Multi-device is their existing behavior, not a feature we have to convince
  them to want — the relay maps onto how they already work.
- They are structurally resistant to the free-competitor pull (§8.3): the
  free tools court users selecting on "free"; this cohort selects on "best
  experience, no limits," and BYOK-native is the only product shape that
  even fits them — a lab's bundled front end can't serve someone who chose
  the API key to escape the lab's plan limits.

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
   *(Confirmed by the 2026-07-08 competitive scan: across the whole
   "browser/mobile UI for terminal agents" field — Happy, CloudCLI,
   Omnara, a dozen smaller OSS projects, and the labs' own web offerings —
   nobody renders the agent's work as generative UI; every one of them is
   a chat/terminal transcript. The genUI frameworks that do exist (Google
   A2UI, AG-UI, Vercel AI SDK) are for building new agent apps, not for
   re-skinning terminal agents. Still uncontested — the clock is running
   but hasn't started expiring.)*
2. **Taste** — the mono-in/rich-out identity, the pin-dock interaction, the
   restraint of registry-first. Big platforms ship lowest-common-denominator
   UI; a niche tool can be opinionated. This is the actual product bet.
3. **Trusted-shell security model** — agent-controlled UI that provably can't
   spoof the prompt box or touch credentials. As prompt-injection attacks on
   agent UIs become news, this becomes marketing, not just engineering.
4. **Local-first trust** — your code and API key never leave your machine
   (§5), and neither does your inference when you run local: local-model
   support (PLAN Phase L) completes the story as "fully local, down to the
   model." The platforms' hosted offerings can't match this posture — a lab's
   front end will never route to a local Llama — so it's a structural
   advantage an indie has over them.
5. **Agent neutrality — the structural moat, and the identity.** genui-shell is
   a **faithful browser re-skin of whichever terminal agent you already use** —
   Claude Code, Codex (OpenAI), Gemini CLI, or one on a local model — each in
   its **own** skin, never homogenized (PLAN Phase P). A Codex user gets Codex
   in the browser; a Claude Code user gets Claude Code; genui-shell's generative
   UI rides on top of each. No lab's own front end can ever be neutral —
   Anthropic's will only ever skin Claude Code, OpenAI's only Codex — so being
   the single surface that faithfully skins *all* of them is the most durable
   advantage an indie holds over every platform, and it **widens the beachhead**
   from "Claude Code users" to "anyone living in a terminal agent, whichever
   one." This is a product requirement and the identity, not a feature (PLAN
   Locked decisions + Phase P), and it compounds with local-first (#4): **your
   agent, your key, your machine, a far better view — for any agent.**
   *(Precision from the 2026-07-08 scan: multi-agent COVERAGE alone is not
   unique — CloudCLI/claudecodeui (12.5k stars, AGPL) fronts Claude Code,
   Cursor CLI, Codex, and Gemini CLI. What remains uncontested is the
   combination this section actually claims: **faithful** per-agent skins
   (inherit the agent's own config, reproduce its walls, never homogenize)
   with the generative UI riding on top. Marketing must claim the
   combination, not bare "works with all agents," which invites a factual
   "so does CloudCLI.")*

## 5. Delivery architecture — the answer to "don't I have to host it?"

**No. Selling on a website ≠ running the workload on your website.**
The product splits into three pieces with very different costs:

```
┌─ marketing site + account/billing ── hosted by you (static + Stripe; ~$0)
├─ the shell UI ───────────────────── static files; hosted by you (~$0)
└─ the engine (agent, bash, files) ── runs on the USER'S machine
```

**Ship as a global install — `npm i -g genui-shell`, then `genui-shell` from
any directory** (on PATH like `claude`/`codex`/`gemini`; `npx genui-shell` is
the zero-install try path, `brew install` later). One command starts the local
daemon (the existing `server/`) and opens the UI. Installing globally and
running from wherever you are — not inside a project — is the whole point:
genui-shell is your terminal agent with a better face, so it launches like one.
Two modes:

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

- **Free (OSS):** full local product, BYOK — **for whichever terminal agent you
  run** (Claude Code, Codex, Gemini CLI, or one on a local model), not
  Claude-only. This is distribution, not charity — every free user is a demo-GIF
  amplifier and a conversion lead.
- **Pro — $12/mo or $99/yr:** relay access (any device), push notifications,
  session sync/persistence, share links, priority support. Price anchored
  against what this audience already spends ($20–200/mo on model access)
  — $12 is an impulse add-on for them. Sharpest for the §2 first target
  (the API-key-by-conviction cohort, added 2026-07-08): they already pay a
  premium precisely to avoid limits while working, so the ask is "make the
  hours you already live in look much better and do more" at a price that
  is noise to them. Competitive anchors (2026-07-08 scan): Happy $0,
  CloudCLI Cloud €7/mo, Omnara $9/mo — all for bare remote access. $12
  holds only if the tier is sold as the genUI experience anywhere (which
  none of them has), not as phone access (which the market zero-priced);
  see the §8.3 amendment and the R.5 packaging check in PLAN.md.
- **Later, maybe:** team tier (shared sessions, SSO) if pull emerges.
- **Never (at this stage):** flat-fee bundled API usage.

Costs: relay + site + auth/billing ≈ $20–100/mo at launch scale. Model
costs: $0 (BYOK). Break-even at ~5–10 subscribers; this business is
structurally profitable almost immediately or it's dead — a clean signal.

## 8. Risks, ranked

1. **Platform risk (severe, unchanged).** Anthropic/OpenAI/Cursor ship genUI
   agent shells natively. *Mitigation:* speed (§9 gates), niche taste they
   won't match, local-first posture they structurally can't match, **agent
   neutrality they *structurally cannot* match** (each lab's shell only ever
   skins its own agent; ours faithfully skins all of them — §4.5), and the
   honest acknowledgment that this caps the outcome at "beloved niche tool,"
   which is the plan anyway.
2. **Demand risk.** Passionate terminal users might be passionate *about the
   terminal* — supervision pain may be tolerated, not paid for. *Mitigation:*
   validation gates (§9) before any billing code is written. *(Amended
   2026-07-07: the launch-complete pivot consciously overrides this — billing
   is built pre-signal so the paid tier exists on launch day. The bounded
   downside: ~2 weeks of build on a paid surface that §9-M3's signal may
   still reject; the pivot-tier-not-product escape hatch stands.)*
3. **Free-rider risk.** OSS local product is good enough; nobody pays for the
   relay. *Mitigation:* phone access + notifications are genuinely hard to
   self-host well; if conversion is still ~0%, the relay was the wrong paid
   surface — pivot the paid tier, keep the audience. *(Amended 2026-07-08,
   competitive scan: the original mitigation is stale — **Happy**
   (happy.engineering, 22.5k GitHub stars, MIT) already ships phone access
   free: E2E-encrypted relay they run at no charge, native iOS/Android,
   voice, QR pairing, Claude Code + Codex, explicitly positioned as
   "no VC, no monetization pressure." Omnara (YC) charges $9/mo and
   CloudCLI Cloud €7/mo for the same surface. So "hard to self-host well"
   no longer protects the relay price — nobody has to self-host it. What
   still holds: (a) the §2 first target selects on best-experience-no-
   limits, not free (added same day); (b) none of them has the generative
   UI — the paid pitch must be "the genUI experience, from any device,"
   never bare phone access, which the market has zero-priced; (c) the
   pivot-the-paid-tier escape hatch stands unchanged.)*
4. **Solo-founder bandwidth.** PLAN.md has ~20 open steps; wedge 1 adds
   relay + mobile + notifications. *Mitigation:* the sequencing in §9 cuts
   scope to a launchable core; everything else waits.
5. **SDK/ToS drift.** The Agent SDK's key requirements, subscription-auth
   rules, or rate structures change under you. *Mitigation:* BYOK keeps you
   out of the blast radius of most pricing changes; wire-protocol seam keeps
   you portable if the SDK shifts.

## 9. Milestones & validation gates

Each gate is a go/no-go with a measurable signal. Do not pass a gate on hope.

> **RESEQUENCED 2026-07-07 (the launch-complete pivot, Kyle's call).** The
> original ladder posted the demo first (M1), open-sourced next (M2), and
> built the paid relay only after M2's signal (M3). The new strategy is
> **one full launch**: hold everything private until the product is
> essentially complete — including the relay and a purchasable Pro tier —
> then post the demo, flip the repo public, publish to npm, and open
> billing on the same day. Rationale: no competitor offers this
> combination (three faithful agent skins + local + generative UI + phone
> relay), so lead with the whole package and let people who want to pay do
> so immediately, instead of drip-releasing the wow. Consciously accepted
> trade-off: the relay and billing get built before any market signal
> (see §8 risk 2). The gates below keep their *signals* — they are now
> read concurrently after the single launch rather than sequentially.
> Build plan: PLAN.md **Phase R** (R.1–R.6); target ≈ two weeks
> (~2026-07-21), relay security core first, inside the Fable-5 window.

- **M0 — Engine live. ✅ PASSED 2026-07-04.** PLAN 0.3/0.7 verified with a
  real key (live smoke: warm multi-turn, workspace file ops, reconnect).
- **M1 — The demo exists. ← BUILD COMPLETE 2026-07-04; the post is
  DEFERRED BY CHOICE.** All of Phase 1 shipped in one day (render protocol →
  registry incl. chart → validation/fallback → pin dock) and the GIF is
  recorded and embedded in the README (`demo/demo.gif`) — a live unscripted
  take with per-beat assertions. The distribution prerequisites are mostly
  done: license settled (**MIT**, 2026-07-05), npm name published/claimed,
  secrets sweep clean. What remains — repo public + post the GIF — is being
  **held deliberately**: the repo stays private while the product is built
  deeper first (Phases T, 2, 3, and all of T2 have since shipped). So M1 is
  build-complete but not launched, on purpose, not for lack of readiness.
  *Gate (unchanged, for when it does post):* the GIF makes a stranger say
  "want." **Signal target: ≥ a few hundred genuine reactions / ≥ 50 GitHub
  stars in week one.** If flat when posted: the thesis needs work — iterate
  the demo, not the infra.
- **M2 — OSS launch.** Repo public; `npm i -g genui-shell` then `genui-shell`
  works cold from any directory on a stranger's machine (packaging is PLAN Step
  4.10), **faithfully re-skinning more than one terminal agent by then (PLAN
  Phase P): a stranger who uses Codex, not Claude, gets Codex in the browser
  just as easily, with local documented (PLAN L.1)**. Show HN with the
  headline **"your terminal agent — Claude Code, Codex, Gemini CLI — in a
  browser, with live UI."** Phase P is a hard prerequisite of this gate, not a
  stretch goal — launching Claude-Code-only would contradict the identity
  (§4.5). *Signal: ≥ 300 stars, ≥ 20 people you don't know running it
  (telemetry-free proxy: issues/discussions from strangers), across more than
  one agent.* Local-setup friction in the issue tracker gates the `--local`
  easy mode (PLAN L.2).
- **M3 — Paid relay.** ~~Build only after M2 passes~~ **resequenced
  2026-07-07: built pre-launch and purchasable on launch day** (see the
  pivot note above; build steps are PLAN Phase R — relay + pairing + E2E +
  phone view + entitlement/billing; push notifications may trail the launch
  rather than gate it, and are not sold until they exist).
  *Signal (unchanged): ≥ 25 paying subscribers in 60 days (~$300 MRR).* If
  the launch lands but nobody pays, audience is real & paid surface is
  wrong — pivot tier, not product.
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

## 11. Immediate next actions (refreshed 2026-07-05)

1. ~~Put a real `ANTHROPIC_API_KEY` in `.env`; close PLAN 0.3 + 0.7.~~ Done.
2. ~~Build PLAN 1.1 → 1.3 → 1.6 (+1.4, +1.5).~~ Done — Phase 1 complete.
3. ~~Record the demo GIF.~~ Done (`demo/demo.gif`, embedded in README).
4. ~~Decide the license; name-check + claim the npm name.~~ Done —
   **MIT** (settled 2026-07-05; daemon MIT, the paid relay is a separate
   closed repo), `genui-shell` published/claimed on npm.
5. ~~Phase T (tool output → interrupt → permission prompts).~~ Done — and
   since then Phase 2 (actions), Phase 3 (sandboxed artifacts), and all of
   Phase T2 (full-stream visibility parity) plus the 4.1/4.2 session
   registry have shipped. The product is well past "daily-drivable."

**Posture (2026-07-05): M1 launch deferred by choice.** The repo is held
private and the GIF unposted on purpose — building the product deeper before
courting an audience, not blocked on anything. The distribution steps (repo
public → post) are staged and can fire whenever the decision is made; §9-M1
holds the go/no-go and the signal target. **Build-side, the live front is now
Phase P — faithful browser skins for more terminal agents (Codex, Gemini CLI),
the identity made real (§4.5): a Codex user gets Codex in the browser, never
Claude. A hard prerequisite of the M2 OSS launch, and ahead of the rest of
Phase 4.** The remaining Phase 4 polish (theming, robust resume, fleet view,
relay) and Phase L (local ergonomics — which comes through whichever agent can
point at a local endpoint) follow it.

**Posture (2026-07-07): the launch-complete pivot.** Everything above
through Phase L.1 is built and verified (three agent skins, Phase 4 core,
local path proven end-to-end). Per the §9 pivot note, the launch is now a
single event held until the relay and the paid tier are ready: PLAN Phase R,
target ≈ two weeks (~2026-07-21), relay security core (R.1–R.3) first while
Fable-5 access lasts (~2026-07-12). **Kyle-side prerequisites, needed early
because of account-verification lead times:** a hosting account for the
relay service + a domain (R.2), and a Stripe account (R.5). Launch day =
demo post + repo public + `npm publish` + billing live, one splash; §9's
M1/M2/M3 signals are then read concurrently against it.

**Measured velocity (2026-07-04):** M0 closeout + PLAN 1.1–1.3, verified and
pushed, in one working day (~5–6 plan steps/day). Half-pace projections
against the gates: M1 demo in hand ≈ 1–2 working days; M2-launchable
(Phase T + 4.1/4.2 + terminal-parity cwd (4.8) + interactive `!` (4.9) +
packaging (4.10) + L.1) ≈ one further week; M3 build ≈ 2–3 weeks but sequenced
by the M1/M2 signal windows, not by code — calendar to first revenue is
realistically 6–10 weeks and gated on audience signal.
