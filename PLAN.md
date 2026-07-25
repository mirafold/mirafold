# Mirafold — Build Plan

A faithful browser re-skin of terminal coding agents — Claude Code, Codex,
and Gemini CLI, one adapter each (Phase P, shipped). The agent's full backend
(filesystem, bash, tools, the warm session loop) runs behind a web front end
where the agent's output stream is treated as a **UI-instruction stream**: the
agent paints into an output zone whose components change shape per response,
while a fixed, trusted shell holds the prompt box and the connection.

Business strategy — positioning, wedges, pricing, go-to-market, and the
milestone gates that sequence this plan — lives in **BUSINESS.md**. The two
build-relevant conclusions from it: ship the Phase 1 demo (1.1–1.3 + 1.6)
before Phase T, and design every seam so the daemon stays local-first.

## Locked decisions

- **Scope:** personal-first, architected so multi-user is additive later.
- **Rendering:** curated component registry first (Level 2), sandboxed
  arbitrary artifacts later (Level 3).
- **Model:** `claude-sonnet-4-6` default, `claude-opus-4-8` switchable per-task.
- **Auth:** personal API keys, server-side only — and for the **closed
  providers** (Anthropic, OpenAI, Google) an API key is the only *fully*
  supported credential. Their terms restrict driving a subscription/OAuth login
  from a third-party app: Anthropic and Google prohibit it outright (local and
  relay) — a Claude/Gemini login shows as `blocked` with the API-key fix — and
  OpenAI grants no written permission either way, so a Codex/ChatGPT login is
  allowed for free LOCAL use as a **disclosed gray area** under the
  **disclosed-uncertainty rule** (Kyle, 2026-07-15: uncertain terms +
  permissive provider posture + minimal exposure ⇒ permissive reading with
  the uncertainty stated to the user, never asserted as permission; the
  `blocked` machinery stays ready for a one-line flip if OpenAI enforces).
  NO subscription of any kind is driven over the paid relay — that bound is
  absolute. API keys and local/BYO endpoints (Ollama, a proxy) are the fully
  supported paths. The one dated source of truth — including the canonical
  statement of the disclosed-uncertainty rule — is `server/provider-policy.ts`
  (R.4i 2026-07-10; re-verified with per-row citations + rule locked
  2026-07-15, K.3). *(This corrects the earlier "the subscription can't drive
  the SDK headlessly — API key is required" claim: R.4b proved it technically
  can; the block is a LEGAL rule, not a technical limit.)*
- **Stack:** TypeScript end to end. Server: Node + Agent SDK + Express + `ws`.
  Front end: React + Vite. Package manager: **yarn**.
- **Distribution: local-first, installed like a terminal agent.** Ships as a
  global install — `npm i -g mirafold`, then `mirafold` run from **any**
  directory, on PATH exactly like `claude`/`codex`/`gemini` (`npx mirafold`
  is the zero-install try path). The daemon runs on the user's machine; we host
  only a static site/billing and (paid tier) a dumb WebSocket relay that
  forwards wire-protocol frames. The engine never runs on hosted compute; the
  API key never leaves the user's machine. Hosted execution is explicitly out
  of scope. (Rationale: BUSINESS.md §5; packaging is PLAN Step 4.10.)
- **Sessions are decoupled from connections.** A connection is a *viewport*
  that attaches to a session in a server-side registry; sessions survive
  refreshes/disconnects and fan out to many viewports (second tab, phone via
  relay). Phase 0 ships the simpler one-session-per-connection stopgap; the
  registry lands in Step 4.2 and is the substrate for persistence (4.1), the
  fleet view (4.6), and the relay (4.7).
- **A faithful browser skin of terminal agents — the product identity, and a
  core requirement.** Mirafold is **not** a generic UI with a swappable
  model. It is a **faithful browser re-skin of whatever terminal coding agent
  you already use** — Claude Code, Codex (OpenAI), and Gemini CLI, all three
  shipped (Phase P) — with Mirafold's generative UI layered on top. A
  Codex user gets **Codex** in the browser (its tools, its behavior, its
  config), never "Claude things";
  a Claude Code user gets Claude Code. "Provider-neutral" here means **faithful
  to each agent**, NOT one homogenized experience, and **no agent is
  privileged**. Mechanically: behind the `AgentSession` seam we run **each
  agent's own engine** and normalize its event stream into `WireMsg`;
  Mirafold's `render_*` / `emit_artifact` tools inject into each agent via
  **MCP** (Claude Code, Codex, and Gemini CLI all support MCP). No translation
  proxy in the request path. We do **not** build a generic agent loop or our
  own tools — that would be faithful to no one. The substrate is already right:
  the wire protocol, output zone, security model, and generative UI consume
  `WireMsg` only, so a new agent is one adapter, not a rewrite. Built as
  **Phase P (shipped 2026-07-06; steps archived in PLAN-ARCHIVE.md)**; the
  normative adapter contract is **docs/ADAPTERS.md**. (Local models
  come through whichever agent can point at a local endpoint — Phase L is the
  ergonomics; Step 1.4's render fallback lets weaker/local models degrade to
  styled text.)
- **Relay service architecture (locked 2026-07-07):** the R.2 relay is a
  **portable Node.js + `ws` process** — the stub's shape grown up — in a
  separate **private repo** (`genui-relay`, the open-core split). No
  proprietary programming model (Cloudflare Workers/Durable Objects
  explicitly rejected: rewrite-to-leave lock-in on the launch-critical
  path). Initial deploy: **Fly.io, single instance/region** — automatic
  TLS, container deploys, and a later multi-region path whose only
  platform-specific code is a ~20-line `fly-replay` routing shim (pair
  affinity), added ONLY if growth demands it. The same artifact runs on
  any VPS/app host, so the vendor is replaceable behind the domain we
  own. Rationale: pair affinity is the hard part of "global relay";
  every zero-ops global offering sells proprietary routing for it, and
  the stateless dumb-forwarder design already caps any future migration
  at reworking one small service while every installed daemon just
  re-dials. (Kyle's constraints, all met: no lock-in, easy scaling, no
  rewrite-on-success beyond that bounded service.) *(2026-07-15: the
  open-core half of this decision is REVERSED — Kyle's call, the relay goes
  open (MIT) too; we sell the hosted convenience, and open relay code is a
  trust asset for the E2E story. The separate repo, Fly deploy, and paid
  entitlement gate all stand unchanged. Executed by Phase K.1; until that
  flip lands the repo remains private.)*
- **Dev without the API:** when `ANTHROPIC_API_KEY` is unset the server falls
  back to a `MockSession` — same `AgentSession` interface, same wire protocol,
  scripted replies (5 shuffled demo templates). Every UI capability is built
  and tested against the mock first; live-agent verification comes last.
- **UI verification:** every front-end step is verified in headless Chrome via
  `playwright-core` (drives real typing/clicks against the system browser).

## Design identity · security model · wire protocol (locked — live in README)

These three load-bearing references were seeded here in Phase 0 and grew
richer, maintained copies in README; the duplicates were retired 2026-07-15
to end the drift risk of two copies. The locked content, and where it lives:

- **Design identity** → README §7 — terminal successor, not a chat app:
  mono-in / rich-out, no bubbles ever, and the **visibility superset +
  collapse-on-finalize** rule (never show less than the terminal; noisy
  streams render live, then fold to a dim expandable line).
- **The core security model** → README §3 — trusted shell vs. sandboxed
  output zone; the boundary is inviolable, and the API key never reaches
  the browser.
- **The wire protocol** → README §2.1 — `server/protocol.ts` is the one
  shared contract, and **later phases ADD message types (or optional
  fields), never reshape existing ones** — every step below relies on that
  rule.

## How to use this plan

Each step below is sized to be completed reliably in a single prompt. Work them
in order. Each has **Goal / Build / Files / Done when**. Do not start a step
until the previous step's "Done when" is satisfied. Check items off as you go.

---

## Completed phases (archived)

**The rule this file follows:** only OPEN steps carry a full body here.
A step that finishes is compressed to a one-line `[x]` pointer, and its
Goal/Build/Files/dated-status history moves **verbatim** to
**PLAN-ARCHIVE.md** — nothing is deleted, only relocated. A completed *phase*
keeps a short summary block plus any **standing rules that outlive it** (those
stay here, because they still bind future work). Everything below marked `[ ]`
is the remaining work.

**Done and archived:** Phases **0, T, 1, 2, 3, T2, P** (the spine through the
faithful per-agent skins) · **4** except 4.7 (→ Phase R) · **G, H, H2**
(relay dedup + human legibility) · **S** (theme system) · **N** (onboarding
backend picker) · **V** (visual + fidelity gaps) · **A** (accessibility) ·
**C** (CI/CD) · **E** (Explorer) · **M** (Mission control), plus the finished
steps of the still-open Phases **K, R, F, Q, L**.

Archive passes, each a section header in PLAN-ARCHIVE.md you can navigate to:
2026-07-08 · 2026-07-10 · 2026-07-15 · "Moved 2026-07-17" · "Moved 2026-07-19"
· "Moved 2026-07-24" (Phases A/C/E/M + V.4–V.6, and the completed material
lifted out of the still-open Phase R steps).

---

## Phase 4 — Product hardening (the "others would want it" path)

Goal of the phase: persistence, multiple sessions, polish, robust resume, and
the multi-user seam. Each step is optional/independent — do as needed. Phase P
shipped first, as required (provider-neutrality was a prerequisite, not a
parallel track); everything below except the 4.7 relay is now done — and 4.7
is expanded into **Phase R** below (the 2026-07-07 launch-complete pivot:
the relay ships *before* launch, purchasable on day one, not after an M2
signal).

Steps 4.1–4.6 and 4.8–4.10 are **done** — moved to **PLAN-ARCHIVE.md**
2026-07-08 with their full dated status notes (same convention as the
earlier phases). Only 4.7 remains below (the pointer to Phase R), plus dated
records of later unplanned polish batches.

- [ ] **Step 4.7 — Hosted relay seam (the paid tier)** → **expanded into
  Phase R below** (launch-complete pivot, 2026-07-07). The original scope —
  daemon dials out via WSS with a pairing token; the relay is a dumb
  forwarder shuttling `WireMsg`/`ClientMsg` frames; to the registry a
  remote device is just another attached viewport; per-pair E2E encryption
  before charging — is unchanged; it's now sized into R.1–R.7 and sequenced
  *before* launch instead of behind the M2 signal. Check this box when
  Phase R ships.

- [x] **Step 4.11 — Cockpit polish batch (unplanned, Kyle-driven)** — done 2026-07-16, all e2e-covered; status bar regrouped (home ⌂ + end far left), collapsible prompt-bar cwd, fleet cwd column → hover tooltip, dismissible new-session card. Theme pill untouched (LOCKED). → PLAN-ARCHIVE.md.

---

## Phase K — Legal & compliance readiness (opened 2026-07-15; gates the remaining Phase R steps)

Origin: a 2026-07-15 full legal review (provider terms re-verified against
current published docs the same day). The finding, in one line: the
architecture already sits on the defensible side of every hard line (the
provider-policy gate, E2E blindness, local-first execution) — what's missing
is almost entirely *paper*: an entity, the two user-facing legal documents,
disclosure hygiene, and a handful of one-command checks. Two decisions Kyle
locked the same day, recorded here:

- **The relay goes open (the 2026-07-07 open-core split is REVERSED).**
  Kyle's call: we sell the hosted convenience, not code secrecy — and open
  relay code is a comfort to exactly the security-conscious audience the E2E
  story courts ("verify what the relay can't see"). The paid tier and the
  entitlement gate are unchanged; only the source visibility flips. Two
  consequences: the deferred git-history-scrub question is now **moot**
  (nothing private left to leak from the shell's history), and the site's
  "open source" line can cover the whole product. Executed by K.1.
- **Billing/tax is outsourced to a merchant of record** (Paddle /
  Lemon Squeezy class) for a fee premium — convenience over margin, Kyle's
  explicit call. K.4 picks the vendor and reworks R.5's Stripe-specific half;
  the Ed25519 entitlement-token design is vendor-agnostic and stands as built.
- **The disclosed-uncertainty rule** (locked 2026-07-15, after K.3 executed):
  when a provider's terms are uncertain — neither clearly permitting nor
  prohibiting — and our exposure is minimal with a visibly permissive provider
  posture, take the PERMISSIVE reading and put the uncertainty in front of the
  user (their account, their call), under two hard conditions: the disclosure
  states uncertainty, never permission; and enforcement degrades gracefully
  (the blocked state + one-line flip stay ready). Written prohibitions are
  always honored; the paid relay always fails closed. Canonical statement
  lives in `server/provider-policy.ts`; first application: the codex
  subscription row.

**Sequencing:** these steps gate the remaining Phase R build steps (R.5
onward) and the R.7 launch — R.7 must not execute while any K step is open
except K.10's actual filing and the parking lot. Nearly everything here is a
decision, a document, or Kyle's-hands account work, so Phase K may proceed in
parallel with Phase H without disturbing H's behavior-preserving invariant;
the only code it touches is a LICENSE file, dated comment edits in
`server/provider-policy.ts`, and (K.3, conditionally) one boolean in that
same file. Steps marked *(assistant: investigate)* need thorough
re-verification against current primary sources before acting — do not act
on this plan's summary alone.

**Sequencing amendment (2026-07-16):** a load-bearing premise was reversed
after verifying Paddle's onboarding directly — **a registered entity is NOT
required to sell.** Individuals/sole traders open *live* Paddle accounts with
identity verification only (no business verification). So **K.2 (the LLC) is
deferred to a revenue trigger** — 50 paying customers or ~$500/mo recurring
revenue, whichever first — alongside K.10, and **R.7 may now launch with both
K.2 and K.10 still open**; the interim seller is Kyle as a sole proprietor
(Kyle Serrecchia d/b/a Mirafold). What still gates R.7: K.5's pages (now live)
and K.6's site pass. Detail in the K.2 / K.4 / K.5 / K.7 notes below.

- [x] **Step K.1 — Open the relay (decision executed)** — done 2026-07-15; genui-relay relicensed MIT (LICENSE + package.json), READMEs rewritten for the open state, shell/BUSINESS docs reconciled, the public-flip moment seeded into R.5b(b); repo stays private until that flip lands. → PLAN-ARCHIVE.md.

- [ ] **Step K.2 — Legal entity before the first charge** *(Kyle's hands —
  external filings; ~a week of lead time, start early)*
  - Goal: no natural person is the counterparty to paid traffic whose
    product feature is "a phone on the internet drives a shell on a
    customer's machine." Unbounded personal liability → bounded entity
    liability, for a few hundred dollars.
  - Do: single-member LLC (state filing directly, or a bundler like Stripe
    Atlas — fine even if billing lands on a merchant of record); EIN;
    business bank account; the billing/MoR account created **under the
    entity** (migrating a personal payments account later is painful). The
    entity becomes the named party in K.5's ToS, the site footer, and both
    repos' LICENSE copyright lines.
  - Done when: the entity exists and K.4/R.5's live payment configuration is
    created under it — a **hard prerequisite**: no live checkout under a
    personal account, ever.
  - **Amendment (2026-07-16 — the "hard prerequisite" is WITHDRAWN, deferral
    decided).** Verified against Paddle's own docs that a registered entity is
    NOT required to go live — individuals/sole traders create live accounts
    with identity verification only. That was the sole hard reason to form the
    entity before launch, so it's gone. K.2 is now **deferred to a revenue
    trigger: 50 paying customers or ~$500/mo recurring revenue, whichever
    first** (Kyle's call — California's flat $800/yr LLC franchise tax isn't
    worth spending before the idea earns). **Interim posture:** sell as a sole
    proprietor; Kyle Serrecchia d/b/a Mirafold is the named party in K.5's ToS
    and the site, with K.5's ToS liability cap + consequential-damages
    exclusion applying in the interim. **When the
    trigger fires:** form the CA single-member LLC (~$70 + $800/yr franchise
    tax), EIN (free), business bank account, **convert the Paddle account from
    individual to business** (supported flow via `sellers@paddle.com` — a
    re-verification cycle, not a rebuild), swap the entity name into ToS / site
    footer / both LICENSE lines, and file the trademark (K.10) under the LLC.

- [x] **Step K.3 — Provider-terms re-verification** — done 2026-07-15; every row pinned to a dated primary source: the Anthropic ban verbatim, Gemini individual-account service ended 2026-06-18 (API keys continue; Antigravity succession check → R.6), and the codex row settled as allowed-locally under the standing **disclosed-uncertainty rule** (no written permission exists, posture visibly permissive; canonical statement in `server/provider-policy.ts`). All four tiers green, twice. → PLAN-ARCHIVE.md.

- [ ] **Step K.4 — Merchant-of-record billing** — 🟡 vendor locked: **PADDLE**
  (investigation 2026-07-15; every hard requirement from BUSINESS §7 + R.5
  verified native against Paddle's docs: card-required 7-day trial,
  cancel-at-period-end, $12/mo · $99/yr, signed `trialing`/`active`
  lifecycle webhooks that map verbatim onto the Ed25519 minting rule,
  hosted checkout from a static page, MoR tax; fees 5% + 50¢, accepted.
  Field comparison — Lemon Squeezy / Stripe Managed Payments / Polar /
  Creem — and the FTC-rule→ROSCA citation correction: → PLAN-ARCHIVE.md).
  Account created 2026-07-16 as **individual/sole trader** (no entity
  required — the finding that deferred K.2). **2026-07-17: both Paddle
  reviews submitted and pending** — domain approval (`mirafold.com`,
  Pending at `/request-domain-approval`) and account verification (the
  KYC form, completed + in review; sole prop, trading name Mirafold,
  business start 2026-07-11, pricing URL `mirafold.com/#pricing`).
  Payout/bank details: an anytime-before-revenue dashboard item. Full
  status history → PLAN-ARCHIVE.md.
  - Done when: both reviews pass and R.5's checkout → webhook →
    entitlement-minting build runs against the account.

- [x] **Step K.5 — ToS + Privacy Policy (from a written data inventory)** —
  done: four pages LIVE on mirafold.com 2026-07-16 (`/terms` `/privacy`
  `/refunds` `/contact` — refund + contact added because Paddle's review
  needs them), written from the real data inventory (E2E-blind relay, IPs
  in memory only and never logged, no cookies/analytics anywhere; Fly.io +
  Cloudflare named as subprocessors, **Paddle an independent controller**);
  named party Kyle Serrecchia d/b/a Mirafold, governing law California;
  ToS carries the warranty disclaimer, fees-paid cap + consequential
  exclusion, the only-systems-you-own AUP line, and the trial/cancel
  mechanics. 2026-07-17: **DMARC live** (`p=reject`, rua→security@ —
  nothing legitimately sends as @mirafold.com; revisit before any
  send-as), **Fly.io DPA executed** (Dropbox Sign via fly.io/documents),
  **Cloudflare DPA verified in force** by incorporation (self-serve
  agreement §6.1, DPA v6.4) — dated copies in Kyle's legal folder, outside
  the repos. The dated inventory doubles as the GDPR Art. 30 record.
  **Open tail rides the K.2 revenue trigger:** lawyer review +
  entity-name swap. Small chore owed: swap the contact page's phone for a
  dedicated Google Voice number once its ID check clears. Full build
  spec + amendments + status history → PLAN-ARCHIVE.md.

- [ ] **Step K.6 — Claim accuracy + third-party trademark hygiene**
  *(executes in the site repo — site PLAN S.7; this step is the contract)*
  - Goal: everything the marketing says about security and about other
    companies' products stays literally true and safely nominative.
  - Build: E2E claims qualified to match the K.5 inventory (the relay sees
    ciphertext plus connection metadata; the R.2 "who serves the app JS"
    asterisk stays honestly worded). A non-affiliation footer on the site
    and in the README's stranger-facing top (the npm page renders it):
    "Claude Code, Codex, and Gemini CLI are trademarks of their respective
    owners; Mirafold is not affiliated with or endorsed by Anthropic,
    OpenAI, or Google." Word marks only — never provider logos, never their
    branded visual identity in our marketing (naming a product to state
    compatibility is nominative fair use; logos and implied endorsement are
    where it dies). ™ on Mirafold until K.10 registers. The K.1 decision
    upgrades the site's "Free and open source — MIT" line to cover the whole
    product — a copy opportunity, not just compliance.
  - Done when: the site pass ships (verified per the site's own
    conventions) and the README carries the same non-affiliation line.

- [x] **Step K.7 — SECURITY.md + vulnerability-disclosure contact (both repos)** — done 2026-07-16; SECURITY.md in both repos (7-day acknowledgment, no bounty, latest-release support, each pointing at its repo's real attack surface), and `security@` + `support@mirafold.com` live via Cloudflare Email Routing → verified inbox, end-to-end tested (leftover Namecheap MX removed; deliverability verified). → PLAN-ARCHIVE.md.

- [x] **Step K.8 — Dependency license scan** — done 2026-07-15; no copyleft in either production tree (shell: MIT/ISC/Apache/BSD + the proprietary Anthropic Agent SDK, stated plainly in README §12; relay: just `ws`, MIT — stale lockfile metadata resynced). Copyright-line swap to the entity stays owed to K.2. → PLAN-ARCHIVE.md.

- [x] **Step K.9 — Contributor policy** — done 2026-07-15; **DCO adopted** over CLA, recorded in R.5b(e); CONTRIBUTING.md in both repos; the GitHub DCO check turns on at the public flip (R.5b/R.7 mechanics). → PLAN-ARCHIVE.md.

- [ ] **Step K.10 — Mirafold trademark filing** *(Kyle's hands; NOT
  launch-gating; assistant: investigate first)*
  - Goal: a priority date on the coined mark before launch attention — the
    GENUI® lesson, applied forward. The 2026-07-11 knockout search was
    clean; an intent-to-use application locks priority **before** launch.
  - Investigate first (assistant): confirm classes (expect 9 + 42), filing
    basis (intent-to-use pre-launch vs. use-in-commerce at launch), specimen
    expectations, and current TEAS fees (~$250–350/class as of the review) —
    deliver Kyle a filing brief he can follow without a lawyer.
  - Do (Kyle): file via TEAS under the K.2 entity. ™ in use until
    registration; ® only after.
  - Done when: the brief is delivered (assistant half) and the application
    is filed (Kyle's half — before or shortly after launch both work).
  - Status (2026-07-15): 🟡 **assistant half DONE — filing brief delivered**
    (written into Step 6 of the Phase-K brief document,
    `~/mirafold-phase-k-your-steps.html`); box open on Kyle's filing.
    Findings, verified against the USPTO's current (post-Jan-2025) fee
    structure: **base application $350/class** (the old TEAS Plus/Standard
    split is gone — one base fee for all §1 and §44 filings); classes
    confirmed **9** (downloadable software — the npm-distributed client)
    **+ 42** (software as a service — the hosted relay) = **$700 up front**;
    **avoid the $200/class free-form-description surcharge** by picking
    pre-approved entries from the Trademark ID Manual inside the filing UI;
    basis **§1(b) intent-to-use** recommended (locks priority pre-launch;
    no specimens at filing), which owes a **$150/class Statement of Use**
    (~$300) with specimens once sales are real ($125/class per 6-month
    extension if needed; windows run from the Notice of Allowance, up to
    36 months). Realistic all-in for both classes: ≈$1,000. Alternative
    recorded: file §1(a) use-based at launch instead — saves the SOU fees
    but gives up the pre-launch priority date, which defeats this step's
    purpose (the GENUI® lesson). Applicant must be the K.2 entity.

- [x] **Step K.11 — Export-control sanity note** — done 2026-07-15; platform WebCrypto only = *standard* cryptography, so the public flip itself completes EAR compliance (15 CFR §742.15(b), post-2021 rule — no BIS notice owed). → PLAN-ARCHIVE.md.

- [x] **Step K.12 — Compliance closure notes** — done 2026-07-15; dated closures, each with its basis: EU AI Act (neither provider nor deployer; faithful-skin rule avoids Art. 25 requalification), EAA (microenterprise exemption; checkout UI is Paddle's), ePrivacy (no cookies/telemetry anywhere — verified in code and live), plus ECPA/OFAC/money-transmission one-liners. → PLAN-ARCHIVE.md.

**Phase K parking lot (post-launch, revenue-triggered — explicitly NOT R.7
gates):** cyber/E&O insurance once real revenue exists; CCPA formalities at
its thresholds (far off at launch scale); **the EU/UK formalities bundle**
(parked 2026-07-15, Kyle's call — a deliberate, written deferral): the GDPR
Art. 27 EU representative, the separate UK representative + ICO
data-protection fee (Tier 1, £40/yr), and the DSA Art. 13 legal
representative for the relay (a mere-conduit-shaped service; no
small-company exemption on paper) are owed only while actually serving
EU/UK residents, and enforcement at launch scale is a paper risk, not a
practical one. **Trigger to act: a meaningful EU/UK customer base — ≈ the
first $1k of EU-sourced revenue or ~10 EU customers. Then: appoint a
bundled EU+UK+DSA representative service under the K.2 entity (a few
hundred dollars/yr) and pay the ICO fee — an afternoon, funded by the
revenue that triggered it.** Until then: sell everywhere via Paddle (VAT
collection is theirs regardless), and this written deferral is the record
that the posture is deliberate.

---

## Phase R — The relay + one full launch (pivot, locked 2026-07-07)

Goal of the phase: launch **once, complete** — the demo post, repo public,
`npm publish`, and a purchasable Pro tier (the relay: your sessions from any
device) all on the same day. Strategy rationale and accepted trade-offs:
BUSINESS.md §9 (pivot note) + §8 risk 2. Target ≈ two weeks (~2026-07-21);
R.1–R.3 are the security-sensitive core — do them first, inside the Fable-5
window (~2026-07-12). Non-negotiables apply throughout, two above all:
secrets/keys never transit the relay, and the relay never becomes a proxy in
the agent's request path — it forwards opaque frames between viewports and
the registry, nothing more. L.2/L.3 stay demand-gated post-launch;
notifications are **not** part of the launch and are not sold until built.

- [x] **Step R.1 — Relay envelope + daemon dial-out** — done 2026-07-07; the relay envelope + outbound WSS dial-out, remote viewports multiplexed as ordinary Connections, verified across all tiers against the in-repo stub. Full status → PLAN-ARCHIVE.md.

- [ ] **Step R.2 — The relay service, deployed**
  - Goal: the dumb forwarder, running in the world.
  - Status: **DEPLOYED and verified in production.** The standalone
    `genui-relay` repo (single source of truth since G.1) is a
    dependency-light (`ws` only) portable Node process — a PURE forwarder:
    parses no frames, stores nothing, serves NO app bundle (the phone app
    loads from the separate static origin, then opens the encrypted
    socket — the documented trust decision). Hardening: global + per-pair
    + per-IP connection caps, frame rate limit, heartbeat reaper, max
    payload, `/health` + 404-everything. Live at `genui-relay.fly.dev`,
    under our name at **`wss://relay.mirafold.sh`** (cert issued; smoke
    passes; a real daemon streamed a full turn while `fly logs` showed
    only connection metadata — the "learned nothing" Done-when, observed
    in production). Full build/deploy/rename history (incl. the GENUI® →
    Mirafold naming story) → PLAN-ARCHIVE.md ("Step R.2 — status history"
    + the 2026-07-17 move).
  - Open to close the box: (1) the **cellular-phone pass** — same flow on
    LTE with wifi off, plus the wifi→LTE mid-turn flip (also R.6's
    real-hardware check; needs only Kyle + signal). (2) **Bake the default
    `MIRAFOLD_RELAY_URL`** (`wss://relay.mirafold.sh`) — today the relay is
    OFF when the env var is unset; baking the default turns it on for
    everyone, so it lands WITH R.5's entitlement gate, never before (R.5's
    explicit launch blocker). (3) The codebase/npm/GitHub **rename**
    genui-shell → mirafold rides this step (domains bought 2026-07-11;
    the Fly app name stays `genui-relay`, internal rename optional).
  - Done when: a phone on cellular (not the home wifi) drives a home
    session through the deployed relay, and the relay's logs show it
    learned nothing but connection metadata.

- [x] **Step R.3 — Per-pair E2E encryption** — done 2026-07-07; WebCrypto AES-GCM, per-connection directional keys off the pairing code, fail-closed on tamper/replay/reorder; the relay sees only ciphertext. → PLAN-ARCHIVE.md.

- [ ] **Step R.4 — Remote viewport UX (the phone experience)**
  - Goal: connecting from a phone is one scan, and driving a session there
    is genuinely pleasant — this is the thing people pay for.
  - Status: built + verified locally 2026-07-07 — the shell-owned `⧉ pair`
    QR affordance (pairing info rides the hello to LOCAL viewports only;
    the code never crosses the relay, even encrypted), a phone-width CSS
    pass (≥40px tap targets, wrapping bars, no sideways scroll), and
    resilience via the existing 4.4 seq-resume + heartbeat. Tier-3
    `phone.e2e.ts` proves QR → pair → drive → permission-by-thumb → a
    mid-turn offline→online flip that RESUMES the stream (pre-blip DOM
    node still connected); Tier-2 pins that a sudo-style password from
    the remote viewport reaches the PTY only (the 4.9 invariant, now
    load-bearing). **2026-07-13: worked end-to-end on a real phone over
    wifi** through the deployed relay + app.mirafold.com. Full build
    detail → PLAN-ARCHIVE.md.
  - Open: the cellular pass (R.2/R.6's LTE check) closes this box; the
    styling/UX punch list that first phone session surfaced is R.4l
    item 1, not this step.
  - Done when: a real phone pairs by QR, drives a full session (prompt,
    render components, permission answer, interrupt) comfortably, and
    survives a network flip (wifi→LTE) mid-turn without losing the
    transcript.

**The gap-close block (R.4b–R.4h), re-sequenced 2026-07-08.** Seven
pre-launch steps from the evaluation series. Step ids are
discovery-stamped and STABLE — commits, memories, and cross-references
cite them — so the letters don't move; the ORDER below is the order to
work them (priority, not discovery date). Cut line if the launch window
forces one: **R.4f, R.4b, R.4h — don't launch without** (a crash bug, the
likeliest-user honesty fix, and the compat fix that's only cheap before
relay skew exists); **R.4d, R.4g — strongly should** (a DoS lever and the
bug-report surface); **R.4c, R.4e — slip only as a last resort** (honesty
polish and security-test insurance).
**Added 2026-07-10 (provider-ToS review — different provenance, same
pre-launch block): R.4i, R.4j. R.4i is don't-launch-without (legal
exposure to Kyle and to users, not polish); R.4j is the prose that pairs
with it. Both sequence BEFORE R.5.**

- [x] **Step R.4f — `!` must not kill the daemon** — done 2026-07-08; per-platform shell selection + wrapped spawn, so a bad shell errors only that session, never the daemon. → PLAN-ARCHIVE.md.

- [x] **Step R.4b — First-run honesty** — done 2026-07-08; live-credential detection, an honest shell-drawn demo banner with no fake cost, onboarding hints, and port-walk + 403 wording fixes. (Its subscription-login-counts-as-live half was later reversed by R.4i.) → PLAN-ARCHIVE.md.

- [x] **Step R.4d — Cap `!` passthrough output** — done 2026-07-08; `BANG_OUTPUT_CAP_BYTES` bounds bang output on the wire and in the replay ring so one runaway command can't flood viewports or evict the transcript. → PLAN-ARCHIVE.md.

- [x] **Step R.4h — Protocol compat hardening** — done 2026-07-08; the Postel split (strict schemas at the source, tolerant `clientSchemas` at the client), tested ignore-unknown on both ends, raw-string fallback for unknown agent names. → PLAN-ARCHIVE.md.

- [x] **Step R.4g — Supportability sweep** — done 2026-07-08; version everywhere (`--version`, boot line, hello, status bar, client skew log), timestamped error mirroring, `MIRAFOLD_DEBUG=1`, secret-scrub warnings, last-gasp crash handlers. → PLAN-ARCHIVE.md.

- [x] **Step R.4c — Resilience honesty** — done 2026-07-08; an explicit "that session ended — started a new one" notice replaces the silent URL swap, and busy/stop clears on a mid-turn daemon drop. → PLAN-ARCHIVE.md.

- [x] **Step R.4e — Prove the artifact sandbox fails closed** — done 2026-07-08; Tier-1 unit tests on `parseBridgeAction`/`wrap()` + a Tier-3 hostile-artifact suite, with a flip-each-defense proof (each containment property has a test that fails when the defense is removed). → PLAN-ARCHIVE.md.

- [x] **Step R.4i — Per-provider credential policy** — done 2026-07-10; `server/provider-policy.ts` is the one source of truth: Claude/Gemini subscription blocked, no subscription over the relay, tri-state onboarding (`live`/`blocked`/`none`), the relay gate in `connection.ts`. Verified all three tiers. → PLAN-ARCHIVE.md.

- [x] **Step R.4j — Reconcile docs & business to the provider policy** — done 2026-07-10 (prose-only); PLAN Auth decision, BUSINESS.md §2/§7/§8.5, both CLAUDE.md files, `.env.example`, README, and the private `genui-relay/README` all cite `provider-policy.ts`. → PLAN-ARCHIVE.md.

- [x] **Step R.4k — Onboarding honesty + local-model discoverability** — done 2026-07-10; live-row endpoint/model `detail`, a named local-model signpost under the picker, where-to-get-it credential links, and the Codex subscription "could change" disclosure. Verified Tier 1 + Tier 3. → PLAN-ARCHIVE.md.

- [ ] **Step R.4l — Pre-release polish + fidelity intake** *(opened
  2026-07-13, the day of the first real-phone pass through the deployed
  relay; Kyle's explicit instruction: document now, fix NOTHING yet)*
  - Goal: every rough edge Kyle has seen gets written down concretely,
    triaged, and scheduled — nothing carried in anyone's head. This is the
    same intake muscle R.5c formalizes for outside testers, started early
    on Kyle's own findings.
  - Known items so far (all reported 2026-07-13; each needs Kyle's
    concrete enumeration before it's actionable):
    1. **Phone viewport styling + small UX issues** — ✅ **RESOLVED
       2026-07-22** over three same-day rounds against Kyle's real phone
       (full round-by-round detail → PLAN-ARCHIVE.md). Round 1: the app frame
       is pinned (100dvh + `overflow-x: clip` + no overscroll — only the
       render zone scrolls) and all focusable inputs are ≥16px, which was the
       actual cause of the sideways drift (sub-16px made iOS zoom on focus
       and LEAVE the page zoomed); viewport meta gained `viewport-fit=cover`
       + `interactive-widget=resizes-content`. Round 2: the phone status bar
       became ONE row with the agent name beside the dot, and **on phone
       Enter NEVER submits** — newline only, with an in-box ↑ send button
       (bottom-right, swaps with ■ esc while busy) as the one way to send;
       desktop Enter-to-send unchanged. Round 3 (Kyle: the on-row fleet
       folder read as clutter on BOTH platforms — the round-2 column was a
       miss): **details-on-demand instead of persistent chrome** — the
       settings card gained a **Session section** (agent, model, folder,
       usage, session id, daemon version), reachable two zero-chrome ways
       (the gear, and the **agent chip beside the dot is now a button**);
       the fleet folder column was removed (desktop hover tooltip restored)
       and the prompt cwd crumb is DESKTOP-ONLY. Pinned throughout in
       `phone.e2e.ts`. **Kyle's real-phone look at round 3 came back
       emphatically positive ("flabbergasted… looks incredible")** — the
       styling core of this item is validated on the device that opened it.
       *The theme pill is hidden on phone with the settings picker carrying
       theme; the Phase S pill lock is desktop-scoped — Kyle confirmed.*
    2. **Desktop styling issues too** — "from the session to the
       fleetview": the session view AND FleetView both have styling
       problems in Kyle's eyes. Details owed; enumerate screen by screen
       with him.
       **Progress (2026-07-25, Kyle-directed session):** the workbench
       frame settled — the activity bar's border line runs unbroken from
       window top to window bottom, the status bar moved inside the
       workbench column (top border meets the line in a T; controls
       vertically centered in the bottom band); fleet rows dropped the
       status word (the dot alone carries state, sr-only text kept for
       screen readers) and the fleet page renders at 1.15× (phone reset);
       styles.css reorganized by surface (pure permutation, rule set
       proven identical); plus one real bug fixed — Fast Refresh re-runs
       `useMemo`, so every dev hot edit leaked an attached socket and
       inflated the fleet's viewport counts (Shell + FleetView now use
       `useState` lazy init).
       **Found, not fixed (same pass — each an equal-specificity CSS
       override killing an intended declaration; one-rule fixes):**
       (a) `.status-line`'s pulse is dead — the cross-cutting rise list
       overrides its `animation`, so the working line never pulses;
       (b) `.onb-agent`'s own transitions are dead — the theme-fade list
       overrides them (press/hover easing off-spec);
       (c) `.files-refresh`'s surface background is dead — `.files-btn`'s
       later `transparent` wins, so the floating refresh button is
       see-through over the rows it scrolls above.
    3. **Permission prompts diverge from terminal behavior — FIDELITY
       BUG, not polish.** Kyle: "permissions questions seem to work
       differently than they do in the terminal, breaking our fidelity
       commitment." The faithful re-skin is the product's core promise
       (never less than the terminal), so treat this as a bug with an
       investigation shape: reproduce per agent (Claude Code / Codex /
       Gemini CLI), write down the exact terminal behavior vs. what the
       shell does (which prompts appear, their wording, approve/deny
       semantics, session-scoped vs. permanent grants, where the answer
       is stored), then close each gap or document the divergence as a
       deliberate, disclosed exception. Specifics owed from Kyle: which
       agent(s) and which prompt flows he saw diverge.
    4. **Startup/onboarding flow — redesign discussion. BIG (Kyle's
       word).** Kyle's sketch (2026-07-13, explicitly not settled — "im
       not sure"): a staged flow — pick the agent first, then how it's
       backed (subscription vs. API keys), then the model. Hard
       requirements he voiced: (a) "simple af"; (b) surface what the
       user ALREADY HAS — detected credentials make it obvious what they
       can pick right now; (c) unavailable options stay VISIBLE but
       clearly unavailable (gray out, not hide — it must read as "an
       option if you want it"); (d) each unavailable option carries
       how-to-get-it instructions inline. Raw material that already
       exists: R.4b/R.4i/R.4k built live-credential detection, the
       tri-state picker (`live`/`blocked`/`none`), per-row `detail`
       labels, and where-to-get-it links — this redesign re-stages that
       material, it doesn't start from zero. One constraint the
       discussion must start from: the "subscription or keys" step
       collides with the provider policy (`server/provider-policy.ts`) —
       Claude/Gemini subscriptions are prohibited in writing (never a
       choice), while Codex subscription is live locally only as a
       disclosed gray area (the K.3 disclosed-uncertainty rule — its
       caveat must ride the option), and no subscription ever rides the
       relay; the flow has to present that honestly per agent rather
       than offering a symmetric subscription-vs-keys fork. Also
       new vs. today: a model-selection step (today model comes from
       DEFAULT_MODEL/agent config, not the onboarding UI). Next action:
       a dedicated design discussion with Kyle BEFORE any build.
       **Status (2026-07-17): the design discussion HAPPENED and the build
       is scheduled — this item's outcome is Phase N** (the two-step
       agent → backing picker with probed local-server discovery; the four
       hard requirements carried into Phase N's charter verbatim). This
       item closes when Phase N ships; items 1–3 remain open intake.
  - Done when: each item above is enumerated concretely with Kyle,
    triaged (fix now / R.6 pre-release blocker / post-launch), and either
    fixed or explicitly scheduled — and the permissions fidelity item has
    a written terminal-vs-shell comparison behind whatever triage it gets.

- [ ] **Step R.5 — Entitlement + billing** *(vendor = Paddle per K.4; the
  build is done and live — see "Still open" at the end of this step)*
  - Goal: paying unlocks the relay, on launch day, with almost nothing
    standing between "want" and "paid."
  - **Vendor + shape (settled).** Phase K.4 replaced the original Stripe
    design with a **merchant of record — Paddle**; the Ed25519 entitlement
    token and the relay-side check were always vendor-agnostic and stood as
    built (Paddle's `trialing`/`active` map verbatim onto "admit when trialing
    OR active"). Pricing **$12/mo · $99/yr**, card-required **7-day free
    trial**, **cancel-at-period-end with no refund**, no money-back guarantee
    (deliberately rejected — the trial covers try-before-buy and a guarantee
    would re-add refund fees plus a revoke path) — all per BUSINESS §7, all
    verified native in Paddle. The original Stripe-worded build spec, the
    K.2-entity prerequisite (later withdrawn), and the pre-build "still owed"
    lists → PLAN-ARCHIVE.md ("Moved 2026-07-24").
  - **Relay `Origin` allowlist — DONE.** Code landed 2026-07-12
    (`RELAY_ALLOWED_ORIGINS`; unset = allow any, a wrong OR missing `Origin`
    refused with a clean close, `CLOSE_FORBIDDEN_ORIGIN` = 4006; daemon
    dial-ins carry no `Origin` and are never gated), and the production value
    was set 2026-07-13 (`https://app.mirafold.com`, live-probed; re-verified
    as surviving the 2026-07-19 redeploy). Closes the 2026-07-08 audit's
    finding #2 — the last "any stranger can open a socket" gap.
  - **Relay entitlement gate — DONE and ON in production.**
    `RELAY_ENTITLEMENT_PUBLIC_KEY` gates daemon dial-ins; the relay verifies
    signature + `exp` OFFLINE via `node:crypto` (no new dep, no vendor call,
    no state — it stays a dumb E2E-blind forwarder) and holds only the PUBLIC
    half, so it can never mint one. Refusal is a clean `CLOSE_UNENTITLED`
    (4007). Backstopped by `RELAY_ENTITLEMENT_MAX_TTL_SECONDS` (7d default)
    per the 2026-07-12 audit's B2.
    **The B2 launch blocker it carries is still live:** baking the default
    `MIRAFOLD_RELAY_URL` (see R.2) must land **with** the gate set, never
    before — an open relay with the gate off lets anyone squat the
    pair/connection caps and lock real daemons out.
  - **2026-07-22 — the BUILD landed across all three repos, and the whole
    path is proven live.** Kyle's two decisions: minting backend =
    **Cloudflare Pages Functions on mirafold.com** (KV state, Pages secrets)
    and token model = **permanent license key + auto-refresh** — checkout
    yields one `mf_…` key set once as `MIRAFOLD_LICENSE_KEY`, and the daemon
    exchanges it at `/api/entitlement` for **48h** Ed25519 tokens (refreshed
    at boot, every 12h, and force-refreshed once after a 4007), so
    cancellation cuts access within ≤48h — the accepted answer to the
    "revocation-before-expiry" refinement. Site: `functions/api/`
    claim/entitlement/paddle-webhook (HMAC-verified raw-body signatures,
    webhook-order-proof KV via an `occurredAt` guard) + the `/welcome`
    landing + CSP `connect-src 'self'` + a 7-test zero-dep suite incl. a
    cross-format guard that mints with WebCrypto and verifies with the
    relay's exact `node:crypto` calls. Shell: `server/relay/entitlement.ts`
    (override env wins outright; the license exchange **never throws or
    blocks the local product** — no token just means the gated relay refuses
    and relay-client prints the existing actionable line), dial-out header,
    boot mode line, a relay-stub gate knob so the send path stays CI-covered.
    Tier 1 **308** / Tier 2 **86**, incl. positive gated pairing against a
    real relay + daemon and the full license-exchange itest. Runbook executed
    the same night and **Kyle's real purchase went end-to-end** — live Paddle
    overlay on `/pay` (hosted checkouts are Paddle-gated; that pivot is
    recorded) → `/welcome` license key → daemon token exchange → paired
    through the closed gate. Per-repo build detail → PLAN-ARCHIVE.md;
    site-side detail + Kyle's runbook → `mirafold-site/PLAN.md` "R.5 billing
    backend".
    *No sandbox and no comped tokens, by decision (Kyle): Paddle is wired
    straight on the live approved account, the 7-day card-required trial
    keeps the end-to-end at $0, testers use the identical full-real flow, and
    past-day-7 charges are paid back personally. `scripts/entitlement.mjs`
    is ops/emergency tooling only.*
  - **Still open on this step:**
    1. The **Pro button → `/pay` link** swap on the site.
    2. The **Paddle.js default-payment-link page**, before real renewals begin.
    3. Deploying the **phone app bundle to the site origin** (the static
       app-serving origin half of this step).
    4. The pre-public-launch hardening trio — claim window ✅ and revocation
       runbook ✅ (both 2026-07-23); the **genui-shell dependabot findings**
       ✅ **cleared 2026-07-25** (postcss bump `c660130` closed the last
       one — zero open alerts on the repo; see R.5b's sweep note).
    5. **token→account binding — deliberately deferred.** The license key IS
       the binding for now: sharing a key shares one subscription's access,
       and a lapsed-then-returning customer gets a NEW key (a re-subscribe is
       a new Paddle subscription id).
  - Done when: a REAL purchase on the live Paddle account (Kyle's own,
    riding the trial) unlocks pairing end-to-end, and expiry/cancellation
    re-locks it without breaking the local product in any way. *(Was
    "sandbox-mode purchase" — superseded by the 2026-07-22 no-sandbox
    decision above.)*

- [ ] **Step R.5b — Release strategy, locked (all three repos)** *(a
  decision to make + write down, not a build; do before R.6's final week)*
  - Goal: one agreed, written release sequence so R.6/R.7 execute a plan
    instead of improvising how each piece ships.
  - Decide and record: (a) **shape of the release** — *first half DECIDED
    (Kyle, 2026-07-22, in commissioning the R.5 build; sharpened the same
    day): a **private beta precedes the public splash**, and it runs the
    **full real billing flow** — NO sandbox, NO comped tokens. The beta
    starts when the relay's entitlement gate flips ON (the `fly secrets set
    RELAY_ENTITLEMENT_PUBLIC_KEY` moment) with live Paddle wired; Kyle's own
    real-card purchase is the first end-to-end, then testers buy real
    subscriptions riding the 7-day card-required trial ($0 if they cancel
    in-window; Kyle personally reimburses anyone charged past day 7). The
    mint script is ops/emergency tooling, not a beta access path.
    **2026-07-22 (night): the gate is ON and the whole path is proven** —
    Kyle's real purchase → license key → daemon token exchange → paired
    through the closed gate; unentitled dials probed refusing 4007. **But
    tester invites are explicitly gated on a phone-view UI pass first**
    (Kyle: obvious flaws remain — see R.4l's phone-styling items; the
    billing machinery being done does not make the product show-ready).
    Still to decide here: beta size/who, its duration/exit criteria, and
    how R.5c's user-testing round folds in;* remainder of (a) — staged
    rollout vs. one splash for the PUBLIC release — **DECIDED 2026-07-25
    (Kyle): ONE splash, as big as possible.** A soft/staged launch
    (publish quietly, announce later) was considered and rejected: the
    pre-public work gates going public at all, not announcing loudly, so
    a quiet period pays nearly the full launch cost for almost none of
    the audience; the channel list was instead expanded (R.6's
    launch-channel prep + Product Hunt in R.7's sequence);
    (b) **per-repo mechanics + order** — `genui-shell` (repo public + `npm
    publish` + versioning/cadence), `genui-relay` (deploy pipeline, **when
    the repo flips public — owed to K.1, which relicensed it MIT**, when the
    entitlement gate flips ON, when the default `MIRAFOLD_RELAY_URL` bake
    lands — see R.2), `mirafold-site` (checkout button flip, demo swap); (c)
    **rollback / kill-switch** for each (the relay gate and per-daemon relay
    URL are the levers) — *for the npm package the rollback move is
    re-pointing the `latest` dist-tag at the previous good version
    (+ `npm deprecate` on the bad one), never an unpublish (npm barely
    permits it and installed users aren't affected either way); for the
    relay it's `fly deploy --image <prev>` (already in
    `genui-relay/DEPLOY.md`); for the site it's the Pages one-click
    deployment rollback (KV does NOT roll back with it — see R.6's KV note)*; (d) how the codebase/npm/GitHub rename (R.2) is
    sequenced into all of the above; (e) *already decided 2026-07-15
    (K.9): contributor policy is **DCO**, not CLA* — `Signed-off-by` per
    commit, CONTRIBUTING.md landed in both repos that day; what remains
    for this step is only the mechanics: enable the GitHub DCO status
    check on both repos as part of the public flip.
  - **CI hardening at the flip (from the 2026-07-21 audit of the C.1 work):**
    once a repo is public, any fork PR's test suite runs on the CI runner, so
    the CI's trust posture matters. Already in place from C.1: the token is
    `permissions: contents: read` (read-only — a malicious dependency install
    script can't push to the repo) and no secrets are used (Tier 4 excluded,
    credentials forced empty). Do AT the flip: (i) re-enable the cross-repo
    relay itest now that `genui-relay` is public and checkout-able — drop the
    `tsconfig.ci.json` exclusion + the Tier-2 `find` filter and add a sibling
    checkout (see Phase C's carried-forward list + `tsconfig.ci.json`);
    (ii) optionally SHA-pin the
    `actions/checkout` / `actions/setup-node` steps (they're pinned to `@v4`
    tags today — fine for GitHub's own official actions, stricter as a full
    commit SHA). No secret was ever added, and none should be — the "no
    provider credential in repo secrets" bound (C.1) is absolute.
  - **Dependency-alert sweep at the flip (2026-07-22 audit):** before EACH
    repo goes public, clear its open Dependabot alerts — open alerts on the
    default branch become publicly visible the moment the repo does, and
    they're a stranger's first impression of the project's hygiene. The
    site repo already carries this in its pre-public hardening trio; this
    line extends the same sweep to **this repo and `genui-relay`**. (Shell
    repo swept 2026-07-22: `shell-quote` ≥1.9 + `@hono/node-server` ≥2.0.5
    forced via yarn resolutions — the MCP SDK still pins hono 1.x upstream,
    so the resolution stays until the SDK moves; all tiers green on 2.0.11.)
    **2026-07-25: shell repo now at ZERO open alerts** — transitive
    `postcss` 8.5.16 → 8.5.23 (GHSA-r28c-9q8g-f849, high, dev-scope; via
    vite, so a lockfile re-resolve only, no resolution needed) landed as
    `c660130`, typecheck + all tiers green (369/103/52), alert #4 verified
    "fixed" via the GitHub API. The `genui-relay` half was verified the
    same day: alerts confirmed ENABLED on that repo (API 204) with zero
    open, and a local `npm audit` at `9f35e2d` found 0 vulnerabilities —
    clean today; still RE-verify at its public flip, since new advisories
    can land anytime.
  - **Gate on the relay flip (2026-07-15 audit):** before `genui-relay` goes
    public in (b), run a dedicated security-audit pass over that repo — the
    shell got its own on 2026-07-15; public security-marketed code gets
    adversarial readers on day one, so the relay flips only after its pass.
  - Done when: a written release-sequence exists that R.6 and R.7 just
    follow, with no open "how do we actually ship this" questions.

- [ ] **Step R.5c — User-testing round before release (Kyle-led)** *(needs
  R.2 deployed + the phone experience end-to-end; gates R.7)*
  - Goal: real users other than Kyle drive real sessions — across the three
    agents, on real hardware and phones, through the deployed relay — before
    a stranger ever does at launch.
  - **Expect this to grow the roadmap.** It is near-certain that testing
    surfaces a batch of small, must-fix-before-release items; each gets
    logged and triaged into Phase R as an explicit launch blocker (its own
    R.5c-N sub-item or folded into R.6), not carried in someone's head. This
    step is the intake for that backlog as much as the testing itself.
  - Done when: the testing round is complete, every finding is written down,
    and each must-fix item is either fixed or explicitly scheduled as a
    Phase R blocker ahead of R.7.
  - Finding #3 (Kyle, 2026-07-24, real phone — SERIOUS): starting a NEW
    session on mobile hung on "connecting…" forever, picker never showed;
    desktop fine. Root cause: the in-session "new" button opens a fresh tab
    (`target="_blank" rel="noopener"`), and a noopener new tab inherits
    neither the URL fragment nor sessionStorage — so on the relay path the
    new tab had no pairing code, fell back to a daemon-less local ws://, and
    hung. Desktop's local fallback IS the daemon (worked); mobile resume
    worked (fleet links stay in-tab). Diagnosed from the daemon
    flight-recorder + relay structured logs. Fixed: `newSessionHref()`
    re-encodes the relay target into the new tab's fragment (PR #6, merged
    to main; unit 322 + round-trip invariant test). DEPLOYED: the
    git-integrated Cloudflare Pages project auto-rebuilt on merge —
    app.mirafold.com now serves the fixed bundle (index-D2UVf2h9.js,
    confirmed live). Awaiting Kyle's real-phone confirmation.
  - Finding #2 (Kyle, 2026-07-23, his MacBook): the onboarding picker sat
    flush against the browser window's top/bottom on a short viewport (a
    ~600px un-maximized Mac Chrome window) instead of floating as a nested
    modal. Root cause: `.onb-card` had `max-width` but no `max-height`, so
    it overflowed the centered overlay. Fixed same day: `max-height: 100%`
    + internal scroll as the hard floor (the overlay's 24px gutter is now
    always visible), plus an `@media (max-height: 700px)` compact layout
    (44px glyph, tighter paddings) so typical content FITS at ~600px.
    Verified by computed-style probe at 607px and 769px viewports + all
    tiers green; worst-case content (3 credential-less agents, longest
    hints) scrolls internally with the gutter intact at any height.
    *(Superseded 2026-07-25: the fleet page's `zoom: 1.15` — a cockpit
    polish landing — inflated the card 15% while this breakpoint kept
    measuring the real viewport, so the scrollbar showed at every height
    under ~890px. The binary compact tier is replaced by a fluid
    `--onb-squeeze` driver: every vertical metric interpolates full→compact
    with window height (zoom factor divided out of the vh math), the
    credentialed picker fits scroll-free down to ~645px real, and scroll
    remains the last resort for hint-heavy or tiny-window states. E2e pins
    the ramp — an all-rows-ready daemon swept through it, asserting no
    internal scroll AND that the glyph actually compressed. `d8abc62`.)*
  - Finding #3 (proactive sweep after #2, same day): the settings and pair
    dialogs share the exact defect #2 found in the onboarding card — the
    S.4 card idiom had `max-width` but no `max-height`. Measured live at a
    560px viewport: settings (583px natural — the theme list) overflowed
    the window by 11px top AND bottom; pair (430px) fit but was one short
    window from the same. Fixed with the same two-line cap on the shared
    idiom (`max-height: 100%` + internal scroll — inert until a card would
    overflow). Sweep completeness: these were the ONLY three
    fixed-position overlay surfaces in the shell (onboarding, settings,
    pair); the in-session model picker, question component, permission
    bar, and demo banner are all in-flow and immune. Probed at 560/769,
    e2e + unit green. NOT done (deliberately): a compact-styles pass for
    the settings card at short heights — it would touch the theme picker's
    layout, which is Kyle-locked territory; internal scroll is the
    accepted behavior there.
  - **Opened 2026-07-23.** Mechanics locked with Kyle: distribution is a
    hand-sent `npm pack` tarball (v0.1.0, shell @ 50950a7 / relay @ 3f92992
    deployed) — NOT npm; testers subscribe FOR REAL via the direct `/pay`
    link (never comped — Kyle's standing rule; 7-day refund is the out);
    feedback arrives ad hoc in any form — Kyle collects and forwards it in
    clusters, so intake here means triaging those clusters as they land,
    not policing a channel. Welcome note drafted (install incl. the
    node-pty/npm-scripts fix, credentials, phone-over-cellular ask, the
    never-paste-boot-output rule, log-file-is-safe-to-attach). That gate CLEARED
    same day: Kyle lifted the blackout entirely — the full site is public
    again, all pages verified 200, and the welcome note now lives on-brand
    at mirafold.com/beta (noindex, unlinked; testers get the direct link).
    The tarball was also rebuilt on the @lydell/node-pty swap, so install
    is two commands with no workaround. NOTHING blocks the first invite.
  - **First finding, fixed same day (2026-07-23):** Kyle, running Codex via
    OpenRouter, saw the literal stand-in "codex" in the status bar's model
    slot (Claude showed "default", Gemini "gemini" — same pattern). Kyle's
    call: a temporary model name that isn't true is dishonest — show
    NOTHING until the real one is known. Landed as shell @ 003388c:
    `modelName` is undefined until configured/engine-reported, the wire's
    usage + fleet-row `model` fields went optional, and the status bar +
    fleet row render the slot only when known. Gemini's "auto" stays (a
    genuine configured router-mode value, still refined per turn). All
    three tiers verified; tarball rebuilt at that commit.
  - **2026-07-25 status:** version bumped to **0.2.0** with the `engines`
    Node floor raised to **>=22** (`52ffdaf` — the floor now matches what
    we actually develop and test on; README, mirafold.com's install note,
    /beta, and the beta-folder WELCOME.md all state Node 22+ and name
    `mirafold-0.2.0.tgz`). Tarball rebuilt at `d8abc62` (includes the
    phone rail fix + onboarding squeeze), staged at
    `../beta/mirafold-0.2.0.tgz`, cold-install + boot smoke-tested.
    **Distribution channel (external fact):** testers get it via Kyle's
    Google Drive link — replace-in-place version upload keeps the link
    stable; Drive keeps the old display name on content swaps, so the
    rename to `mirafold-0.2.0.tgz` is a manual step (advised, link
    survives it). **Uptake (Kyle, 2026-07-25): almost no testers have
    actually tried it yet** — the stable-link swap was chosen so the
    already-sent link serves the new build. Also flagged on push: GitHub
    reports 1 HIGH Dependabot alert on the default branch (dependabot/4);
    a dependency bump was already in flight in a parallel session the
    same afternoon. *(Resolved same day: that bump landed as `c660130` —
    alert #4 "fixed", zero open alerts on the repo; detail in R.5b's
    sweep note.)*
  - **Tarball rebuilt again 2026-07-25 (evening), from this commit's tree
    (parent `d743632`)** — still **0.2.0**, no version bump: the only
    code-affecting change since the `d8abc62` build is the transitive
    postcss 8.5.16 → 8.5.23 bump in `c660130`, which moves the built CSS
    asset and nothing else. Staged at `../beta/mirafold-0.2.0.tgz` and
    verified the way a tester installs it: cold `npm i -g` into a
    throwaway prefix, `mirafold --version` → 0.2.0, real boot serving
    HTTP 200. Tier-1 (369 tests) + typecheck green on the tree it was
    built from.
  - **npm-audit noise on install — investigated and settled
    (2026-07-25):** installing the tarball into a *local project
    directory* reports 4 moderate advisories, all one chain
    (`@hono/node-server` <2.0.5 — Windows-only path traversal in
    `serve-static` — reached transitively via `@modelcontextprotocol/sdk`,
    which `@anthropic-ai/claude-agent-sdk` also requires as a peer).
    **Testers never see it: npm skips audit on global installs**, so the
    documented `npm i -g ./mirafold-0.2.0.tgz` prints no advisory at all
    (verified against a clean prefix). And it cannot be fixed from our
    side anyway: the MCP SDK still declares `^1.19.9` at its latest
    (1.29.0), hono 1.x has no patched release (1.19.15 is the last), a
    published package's own `overrides` field is ignored by npm (verified
    by packing one and installing it), and **npm v12 no longer reads an
    `npm-shrinkwrap.json` shipped inside a tarball** — the one mechanism
    that used to pin a consumer's transitive tree. `bundleDependencies`,
    npm's suggested replacement, is a non-starter here: `@lydell/node-pty`
    and the agent SDK ship per-platform optional binaries. What DID land:
    `package.json` gains an `overrides` block mirroring the existing yarn
    `resolutions`, so an `npm install` from source resolves the same tree
    yarn does (`npm install --package-lock-only` → 0 vulnerabilities);
    it has no effect on the tarball. Our own testing keeps running the
    forced 2.0.11, as R.5b's sweep note records.
  - **Do not run `npm install` in this repo** (learned 2026-07-25):
    `npm install --package-lock-only` silently rewrote `yarn.lock` —
    dropped every non-Linux platform entry (`@lydell/node-pty`, the agent
    SDK's darwin/win32 binaries) and all the integrity hashes. Restored
    from git and re-verified with `yarn install --frozen-lockfile`. Use
    yarn for every package operation, as CLAUDE.md already says; npm is
    for `npm pack` only.

- [x] **Step R.5d — Relay staging (nonprod) environment** — **DONE
  2026-07-23** (the day the private release went live, per the sequencing).
  `genui-relay-staging` on Fly from the same Dockerfile via
  `fly.staging.toml` (auto-stop, idles at zero, ungated); the Deploy
  workflow gained the environment dropdown (default staging) with
  per-environment app-scoped FLY_API_TOKENs (staging's token cannot touch
  production); first staging deploy dispatched through the new path and
  the full smoke PASSED against `wss://genui-relay-staging.fly.dev`
  (pairing + byte-identical round-trip + refusals). Runbook: DEPLOY.md §6.
  Why it exists: the relay is the only component that needs a nonprod — the
  shell's "production" is the user's own machine and the site already has
  Pages previews. Staging exercises what local runs can't: real TLS, the
  `fly-client-ip` header the rate limiter trusts, real network behavior, Fly
  machine lifecycle. The flow it buys: deploy a ref to staging → point a local
  shell at it (`MIRAFOLD_RELAY_URL=wss://genui-relay-staging.fly.dev`) → smoke
  + phone pairing check → dispatch the same ref to production. Original step
  spec → PLAN-ARCHIVE.md.
- [ ] **Step R.6 — Launch prep (the week before; everything verifiable
  without publishing)** *(split out of the old launch-day mega-step
  2026-07-08 — same items, grouped so nothing hides mid-paragraph; nothing
  here requires `npm publish`, most of it requires R.2's deploy)*
  - Goal: on launch morning, R.7 is a three-move sequence, not a scramble.
  - **Availability posture (from the 2026-07-23 error-monitoring + DDoS
    review; uptime monitors on `relay.mirafold.sh/health` + `mirafold.com`
    are already live and tested on Kyle's UptimeRobot account):**
    - Verify the Cloudflare WAF rate-limiting rule on `/api/*` actually
      exists in the dashboard — it's step 4 of the billing runbook in
      `mirafold-site/PLAN.md` and the one item there never check-marked.
      `/api/entitlement` is the only public surface doing per-request work
      on attacker-suppliable input; the rule is the throttle in front of it.
    - [x] **DDoS acceptance + exit path — DOCUMENTED 2026-07-23** in
      `genui-relay/DEPLOY.md` §8: the accepted-risk position (stateless,
      E2E-blind relay; local sessions untouched; blast radius = remote
      uptime) plus the ready-to-execute Cloudflare-fronting shelf plan —
      DNS proxied to the Fly origin, `RELAY_CLIENT_IP_HEADER` →
      `cf-connecting-ip` (env-only, no code change), origin-bypass lockdown
      so the header can't be spoofed, optional CF rate rule. Document-only,
      as directed.
    - [x] ~~The next relay deploy must land before launch~~ **DEPLOYED
      2026-07-23** — `HEAD /health` + structured JSON event logging live and
      verified in production (typed refusal events observed; entitled daemon
      paired post-deploy). The smoke script gained `RELAY_ENTITLEMENT_TOKEN`
      support the same day (it predated the gate flip and couldn't fully
      pass against the gated relay; now it passes with a minted token and
      fails fast + actionable without one).
    - [x] **License-KV re-derivation check — ANSWERED 2026-07-23** (full
      writeup in `mirafold-site/PLAN.md` "KV durability"): license keys are
      minted random (`crypto.getRandomValues`) and stored ONLY in KV, never
      pushed to Paddle — so a lost `LICENSES` namespace is NOT re-derivable
      (status rebuilds from Paddle, but the key↔sub binding is gone, and a
      support re-mint yields a DIFFERENT key forcing every customer to update
      `.env`). Decision: a **periodic KV export** is the cheaper mitigation
      (owed pre-launch, not yet built); Paddle `custom_data` write-back is
      the noted self-healing upgrade if ever warranted.
  - [x] **npm install-scripts blocking — SOLVED at the root same day
    (2026-07-23):** recent npm blocks packages' install scripts by default,
    so upstream `node-pty`'s postinstall compile never ran and the daemon
    crashed at first boot (found in the beta cold-install check). Fixed by
    swapping to `@lydell/node-pty` (Kyle's requirement: no breakage, no
    manual workaround, ever): identical API, prebuilt binaries for six
    platform/arch combos as `optionalDependencies` — no install script to
    block, no toolchain needed on any platform. Verified: all tiers green
    (319/86/38, PTY bang tests included) + a cold tarball install under
    blocked scripts boots and spawns a real PTY with zero interventions.
    README native-module note updated; the welcome note's workaround
    section deleted.
  - [x] **Standing-secrets rotation runbook — WRITTEN 2026-07-23**
    (rotate-on-event policy, per-secret order + disruption window). The
    Pages-side three (`ENTITLEMENT_PRIVATE_KEY`, `PADDLE_API_KEY`,
    `PADDLE_WEBHOOK_SECRET`) are in `mirafold-site/PLAN.md` "Standing-secrets
    rotation runbook"; the deploy-side two (`FLY_API_TOKEN` per environment,
    and the relay's `RELAY_ENTITLEMENT_PUBLIC_KEY` half of the coupled
    entitlement-keypair cutover) are in `genui-relay/DEPLOY.md` §7. Key
    findings captured: the webhook-secret rotation is zero-downtime (Paddle
    allows multiple active `h1=` and `verifyWebhookSignature` already loops
    them); the entitlement-keypair cutover has no overlap window (the relay
    holds one key) so it MUST be rehearsed on the R.5d staging relay before
    production, with daemons self-healing via the 4007 refusal. Still owed
    as a BUILD (not a doc): the periodic KV export from the re-derivation
    finding above.
  - **Gemini CLI succession check (from K.3's re-verification, 2026-07-15):**
    Google stopped serving Gemini CLI requests for individual accounts on
    2026-06-18 and announced **Antigravity CLI** as the successor terminal
    agent (API-key/enterprise users continue on the legacy CLI for now).
    Verify our `gemini-cli` adapter still drives a real turn with an API key
    on current bits, and write down the Antigravity question (new adapter?
    rename? drop?) as a post-launch decision — the faithful-skin seam means
    it's one adapter either way, not a rewrite.
  - **Assets & copy** — **POSITIONING LOCKED (Kyle, 2026-07-23): NO
    competitor mentions, anywhere, ever. Act as if they don't exist —
    because they don't; no one owns this space like we do.** All copy stands
    on what Mirafold IS, never on a contrast with anyone else. This
    supersedes the earlier 2026-07-08 "competitive scan" framing below.
    - Refresh the demo GIF with the phone beat (the §6 launch asset as
      originally imagined) — the phone beat must show a RENDERED COMPONENT
      on the phone (live checklist, chart, pinned widget), not a chat
      transcript on a phone.
    - Launch copy leads with "your terminal agent with a real UI —
      faithfully, whichever agent you run"; phone second.
    - **The README opening paragraph is a crisp, quotable, standalone
      definition of Mirafold** (it's what AI chatbots draw on when asked
      what the product is). Written purely as what it is — the faithful
      per-agent skin + generative UI + your-machine trust story — with zero
      comparison. NO "honest comparison" / "how is this different from X"
      FAQ — that item is REMOVED by the locked decision above. If asked "how
      is this different," the answer is what Mirafold does, stated plainly,
      not a competitor teardown.
  - **Launch-channel prep (added 2026-07-25 — Kyle: try basically everything
    feasible and worth the time; every channel below is $0 via its free
    route — paid placements exist at some of them but are advertising, not
    submission fees, and are not used):**
    - **Product Hunt** ($0): draft the listing + maker comment ahead of
      launch morning — launches run midnight-to-midnight Pacific and the
      first hours of votes decide surfacing. Fires launch day with the rest
      of the splash (added to R.7's sequence).
    - **Dev-newsletter submissions** ($0, organic forms): TLDR / TLDR AI,
      JavaScript Weekly + Node Weekly (Cooperpress — Mirafold is a Node
      tool, squarely eligible), Console.dev, Changelog News. Submit all of
      them launch week; editors also trawl HN front pages, so a good HN
      showing compounds here.
    - **Lobste.rs** ($0, but posting is invite-only): seek an invite before
      launch; if none materializes, skip — don't chase it.
    - **GitHub discovery surfaces** ($0): once the repo is public, PR a
      one-line entry to the established awesome lists (the Claude Code
      ecosystem list, local-LLM tooling lists). Trending needs no action —
      a launch-day star spike feeds it on its own.
    - **Post-launch follow-ups, not launch-day** ($0): an Indie Hackers
      launch post (the solo-builder-ships-a-real-product story), and
      podcast pitches (Changelog, Syntax and the like — weeks of lead
      time; pitch once the launch gives a story to tell).
  - **Package & repo hygiene** (2026-07-07 friction log + 2026-07-08
    operability review) — **ALL DONE 2026-07-08:**
    - [x] Pin a `packageManager` field in package.json — `yarn@1.22.22`
      (matches the v1 lockfile; corepack now resolves a fixed yarn).
    - [x] Add `bugs` / `homepage` / `author` to package.json (author =
      "Kyle Serrecchia (github.com/kserrec)"; homepage/bugs = the GitHub
      repo for now — swap homepage to the R.2 domain once it exists).
      `npm pack --dry-run` re-verified: 9 files, ~264 KB, LICENSE + README
      in, `.github/` NOT shipped (not in the `files` whitelist).
    - [x] README §8 tarball footnote: names the real prerequisites (`yarn`
      on PATH + a prior `yarn install`, since `prepack` runs `yarn build`)
      and the corrected size (9 files, ~264 KB — the real current number,
      not the ~259 KB estimate).
    - [x] Refresh the dated `DEFAULT_MODEL` suggestion in `.env.example` —
      now unset by default (Claude Code inherits its OWN configured model,
      the faithful-skin default) with a comment showing how to pin one
      (`claude-sonnet-5` as the example); no stale id shipped.
    - [x] GitHub issue template (`.github/ISSUE_TEMPLATE/bug_report.md`)
      leading with the SCRUB-two-secrets warning (`?token=` URL + relay
      pairing code) before any log paste; asks for `--version` and
      `MIRAFOLD_DEBUG=1`.
    - [x] Secrets sweep of the repo (relay-service included): `.env`
      gitignored + untracked; no secret-shaped strings in tracked files
      (only doc prose + the deliberate `OPENAI_API_KEY=local` dummy).
    - [ ] Dependency vulnerability audit right before publish (`yarn audit`
      / `npm audit` on the daemon AND `relay-service/`) — clear or pin
      anything flagged in `express`, `ws`, `react-markdown`, the agent
      SDKs, etc. (2026-07-08 security audit: the one item that can't be
      cleared offline; a known-vuln transitive dep is a real ship risk).
    - [ ] Cap the model-label length where it enters the wire (2026-07-16
      audit, hardening tier — no live risk): the label comes from
      engine-controlled sources (Claude `system/init`, the Codex rollout
      file, Gemini stats) with no length bound, so a corrupt source could
      bloat every `sessions` broadcast and the status bar. One `slice()` at
      the registry/usage emission covers all adapters at once — same
      philosophy as R.4d's `!`-output cap. React escaping already makes a
      hostile string inert (verified); this is bloat insurance only.
  - **Real-hardware checks** (need R.2 deployed; none need the registry):
    - Local-model turn COMPLETION (Phase N.6 residual, 2026-07-17): the
      discovery→pick→configure path is fully verified (the picked model's
      prompt observed arriving inside Ollama), but the only model on the
      dev machine (1.7B, CPU) can't prefill an agent-sized prompt before
      the SDK request timeout. Drive one full turn through a
      picker-chosen local model on realistic hardware or with a
      realistically-sized model (docs table: qwen3-coder-class) —
      claude→ollama and codex→ollama both.
    - Scan the QR with a real phone through the deployed relay, drive a
      session, flip wifi→LTE mid-turn (owed by R.4 — now listed, not just
      owed).
    - ~~Relay cap sanity under real load~~ **✅ done 2026-07-19 (evening).**
      Per-IP cap (64) verified on the LIVE relay behind Fly — holds at exactly
      64, logs `per-IP cap reached (64) — refusing one source`, which also
      **confirms `fly-client-ip` reaches the process** (fired on the real
      client IP, not Fly's proxy IP). Global cap verified locally (holds at
      cap, reclaims on close). All read SERVER-SIDE (relay logs +
      `connections()`); a client-side harness was unreliable for the
      refuse-after-handshake pattern (relay `close(4004)`s just after the WS
      `open`, so the client briefly sees "open"). Side effect: the live relay
      was **redeployed to current code** (had been v4/Jul-13 — all Phase-G+
      work was unshipped; now current + health-verified). Still NOT done (not
      blockers): the NAT'd-office many-users-one-IP case; a daemon-side check
      that a client cleanly surfaces the 4004 refusal (fold into R.4).
    - ~~Pre-handshake flood hardening (2026-07-12 audit, B3)~~ **✅ done
      2026-07-19 (evening).** `server.headersTimeout`/`requestTimeout`/
      `maxConnections` are set explicitly in `relay.ts` (were already wired as
      `createServer` options). Slowloris load-test PASSED against a local relay
      with dialed-down knobs: a frozen handshake is cut by `headersTimeout`, a
      *dribbling* one (writes a header byte every 400ms to defeat the headers
      timeout) is cut by `requestTimeout` at the total-request bound, while a
      real upgrade opens in ~40ms amid the flood and survives past both
      timeouts (they clear on upgrade), and the socket floor (`maxConnections`)
      bounds raw half-open sockets.
    - macOS and Windows cold-installs from the tarball; on the Windows
      pass, run `!dir` (the R.4f fix's real-hardware check).
    - The real `!sudo -v` password entry (Kyle — verified through the
      masked prompt earlier, killed before entry; only Kyle can finish it).
    - Kyle's final eyeball of the credential-less onboarding presentation
      (R.4b builds the fix; this is the last look at how it reads).
  - Done when: every box above is checked and the only remaining
    launch-blocking action is R.7's publish sequence itself.

- [ ] **Step R.7 — Launch day (the M1+M2+M3 splash, one event)**
  - Goal: everything fires together and the signals start reading.
  - **Launch-week provider-terms re-check (K.3's standing item):** within
    the launch week, re-verify all three rows of `server/provider-policy.ts`
    against current provider documents and re-date the file — all three
    providers moved within H1 2026, and launching on a stale row is exactly
    the exposure K.3 exists to close. Includes re-checking the codex
    disclosed-gray-area row both ways: a written OpenAI allowance would let
    its caveat drop; signs of enforcement (the Anthropic pattern:
    server-side blocks first, docs later) mean flipping it to blocked —
    one line, the copy sits ready.
  - **Tracked-docs & history disclosure review (2026-07-15 audit):** before
    "repo public", read what actually goes public — the full git history plus
    tracked candor docs (`BUSINESS.md`, `PLAN.md`/archive: pricing strategy,
    provider-policy legal reasoning, negotiation-sensitive detail). Decide
    keep / trim / move-private for each; no secrets exist in history
    (verified 2026-07-15), this is a business-disclosure call, not a leak hunt.
  - **Theme guards: constrain token VALUES before accepting community theme
    PRs (2026-07-16 audit; partially closed by V.1, 2026-07-18):** the
    Tier-1 guards pin token names exactly but not all values — a
    contributed theme file could carry a working-but-weird value (e.g.
    `url(...)` in a color slot). *V.1's contrast floors now force every
    text tier, accent, and surface token (~18/theme) to parse as plain
    6-digit hex, so the remaining gap is only borders, the tinted
    families, and the misc tokens (overlay/selection/shadows, which
    legitimately use rgba()/shadow lists).* The shell CSP already blocks
    the fetch at runtime and a reviewer sees the diff, so this is
    belt-and-suspenders: add a guard asserting the REMAINING values parse
    as colors/alpha-colors/shadow lists, so `yarn test` rejects it
    mechanically. Matters only once the repo is public and taking PRs —
    land it with (or before) the public flip.
  - ~~**SECURITY.md: name the `!`-output → model path (2026-07-17
    audit)**~~ — **done early, 2026-07-23**: landed in SECURITY.md's
    "Known trust decisions" section, together with the Q.5 symlink
    residual of the `.env` guard (also now disclosed there).
  - Build, same day, in order: repo public → `npm publish` over the 0.0.1
    placeholder → verify `npx mirafold` against the real registry (the
    one check that's unverifiable until publish) → post (X + Show HN +
    Product Hunt + r/ClaudeAI + r/LocalLLaMA with the "BYOK or fully
    local" line) with Pro purchasable from minute one. Same week, riding
    the splash: the newsletter submissions and awesome-list PRs prepped
    in R.6's launch-channel item (all $0).
  - Done when: a stranger can watch the GIF, install cold, run their own
    agent, pay, and drive it from their phone — all within the launch
    hour. Signals per BUSINESS.md §9 read concurrently from here.

---

## Phase N — Onboarding backend picker (opened + completed 2026-07-17; the R.4l item-4 redesign)

✅ COMPLETE — full bodies + dated status in PLAN-ARCHIVE.md ("Moved 2026-07-19").
Two-step onboarding: pick the agent, then how it's backed — every detected
credential (explicit choice replaces silent API-key-wins; server-validated)
plus running local model servers found by probing
(Ollama/LM Studio/vLLM/llama.cpp), dialect-filtered per agent, with a live
re-probe while the picker is open; per-session enforcement through each SDK's
own env/config. Live-verified on Kyle's machine.

- [x] **N.1 — Enumerate configured backends (server-side truth)** — done 2026-07-17. → PLAN-ARCHIVE.md.
- [x] **N.2 — Local model server discovery (the probe)** — done 2026-07-17. → PLAN-ARCHIVE.md.
- [x] **N.3 — Advertise backends on the wire (additive) + live re-probe** — done 2026-07-17. → PLAN-ARCHIVE.md.
- [x] **N.4 — The second-step picker UI** — done 2026-07-17. → PLAN-ARCHIVE.md.
- [x] **N.5 — Session creation honors the choice** — done 2026-07-17. → PLAN-ARCHIVE.md.
- [x] **N.6 — Live verification + docs reconciliation** — done 2026-07-17. → PLAN-ARCHIVE.md.

## Phase V — Visual + fidelity gaps flagged by Kyle (opened 2026-07-17; ✅ COMPLETE)

Full bodies + dated status in PLAN-ARCHIVE.md ("Moved 2026-07-19").

- [x] **V.1 — Theme contrast pass (all six themes)** — done 2026-07-18; terminal-grade worst-case-surface contrast floors in the Tier-1 guard, hues preserved; seven-theme lineup settled (Mirafold house default; Standard dark + light; Solarized Light/Dark; Gruvbox Dark; Dracula); brand mark beside the empty-session greeting. → PLAN-ARCHIVE.md.
- [x] **V.2 — Codex (and Gemini) rendering + command fidelity** — done 2026-07-19; Codex chart-degradation root-caused (Codex hides MCP tools behind tool-search) and fixed (deferred-tools addendum + a deterministic mermaid backstop); `/model` re-skinned for BOTH Codex and Gemini from each binary's own catalog (Codex app-server JSON-RPC / Gemini ACP); Codex-on-OpenRouter probed. **Follow-up:** the `/effort` reasoning-effort scaffold landed 2026-07-19 (mock-built; TWO fidelity questions — per-model effort availability, and fold-into-`/model`-vs-standalone — pending a live Codex pass). → PLAN-ARCHIVE.md.
- [x] **V.3 — Truthful full-optionality Codex backend picker** — done 2026-07-19; every way codex can run is a picker row from config.toml ground truth (all `[model_providers]`), key-gated, provider carried on the wire, per-session enforced. → PLAN-ARCHIVE.md.
- [x] **V.4 — In-session ergonomics: a "new" button, prompt focus, terminal scrollback** — done 2026-07-20 (Kyle-directed, same day); `new` button beside home opening the startup screen in a fresh tab, `end` moved far right, caret starts in the prompt box on entering a session (never stolen from an open overlay or a live selection), and terminal-scrollback conditional autoscroll. → PLAN-ARCHIVE.md.
  - **⚠ The one thing still open:** the phone half of the scroll work is unverified by hand. Follow-the-tail detaches on a downward finger drag with **no minimum distance**, so a tap whose thumb wobbles a pixel (expanding a tool block, a pin button, a question option) silently stops auto-scrolling and the agent then looks stalled with nothing on screen explaining why. Kyle's call 2026-07-20 was to ship it and find out by hand. If it bites: require ~8px of travel before a drag counts as steering, in `onTouchMove` (`web/src/use-follow-tail.ts`) — a real swipe is hundreds of px, thumb noise is 1–2. The touch handlers are also **not proven necessary at all** (touch held correctly without them); they are kept only as a guard for iOS Safari, untestable on this machine.
  - **Note for anyone touching `use-follow-tail.ts`:** following scrolls **instantly, never smoothly**, and the reader's **input** is what detaches, not a position delta. Both were bought with a bug — a permanently in-flight smooth animation owned `scrollTop` and made the wheel inert during streaming. The trace and evidence are in commit `00288c6`; re-read it before reintroducing either.
- [x] **V.5 — The one-click picker row names its backing** — done 2026-07-20 (Kyle-directed, same day). Choosing Gemini started a session without ever saying an API key was what it ran on; `AgentInfo` gained an additive optional `kind` (set only when `live`) and the row renders `backingLine()` — the wire carries the *kind* as a fact, the client owns the wording, so the one-click row and the second step say the same words. Same day, Kyle's call: credential labels now use each vendor's OWN name — **"Gemini API key"** (not "Google API key" — that's the Vertex path), **"Claude API key"** (the API was rebranded from Anthropic API); the "ChatGPT subscription" / "OpenAI API key" asymmetry is OpenAI's own brand split, inherited deliberately and documented at `backendLabel`. → PLAN-ARCHIVE.md.
  - **The principle, worth keeping:** a single usable backend isn't "no choice to show," it's *a choice made on the user's behalf* — a menu you don't need can be skipped, but a decision made **for** the user must still be stated.
  - Considered and **rejected** for now: making the backend menu reachable from a one-click row. It costs a real restructure (the row is a single `<button>`; a nested button is invalid HTML) to answer a question the row's own label mostly pre-empts. Revisit only if a real user asks it.
- [x] **V.6 — The /model picker becomes real shell chrome (+ session polish batch)** — done 2026-07-22 (Kyle-directed, same day). Kyle hit V.2's fallback live: a Codex catalog past 4 rows degraded `/model` to a non-interactive list, where terminal Codex gives arrow-key selection at any size. Root cause named and fixed **structurally** — the re-skin had borrowed the agent-facing `question` component, **whose option cap is discipline on generated UI and must never bind a shell re-skin of terminal chrome**. Now an additive `picker` wire message + shell-owned `PickerBlock.tsx` (NOT a registry component): any row count, arrow/Enter/Escape captured globally from the idle prompt box, serving codex `/model`, codex `/effort` and gemini `/model` through one shared `emitModelPicker`. → PLAN-ARCHIVE.md. Same sitting, all Kyle-directed: question component option cap **4 → 6** (fidelity note: Claude Code's own AskUserQuestion still maxes at 4, so real agent questions stay ≤4 — the wider cap is headroom); the fresh-tab **white flash killed** (inline pre-CSS canvas paint in `index.html`, cleared by `main.tsx`); `.sb-pair` joined the 34px control row; and the **Tier-2/3 harness now scrubs the paid-tier env** (`MIRAFOLD_APP_URL`, `MIRAFOLD_LICENSE_KEY`, `MIRAFOLD_ENTITLEMENT_TOKEN/URL`) like credentials — a dev shell live-testing the paid path had relay itests dialing the real billing backend (one hung 45+ min).
  - **Ops lesson, recorded:** two sessions sharing one checkout DO cross-contaminate commits — whichever commits first sweeps up the other's in-progress edits.

## Phase A — Accessibility (opened 2026-07-20; ✅ COMPLETE 2026-07-21)

Kyle's directive, verbatim: *"i want mirafold to be friendly to all people
capable of using it and to be ada compliant."* The ADA names no technical
standard for software, so the operative target is **WCAG 2.1 Level AA**.
All five steps done 2026-07-21 (Tier-1 307 · Tier-3 35 at close); full step
bodies, the whole Orca-walk log and the axe-sweep detail → PLAN-ARCHIVE.md
("Moved 2026-07-24"). What shipped: two `.sr-only` live regions
(`Announcer.tsx` — polite `role=status`, assertive `role=alert`) announcing at
semantic boundaries with the transcript held at `role="log"` +
`aria-live="off"`; dialog semantics + `useFocusTrap` + `.behind-dialog`/`inert`
sibling-hiding on all three overlays; the FleetView stretched-link card;
`speechFromMarkdown()` so the turn-end announcement speaks prose, not raw
markdown; and the public statement (A.4).

**Standing rules that outlive the phase — do not re-open:**

- **Contrast is done.** V.1's terminal-grade floors (strong ≥12 · fg ≥11 ·
  body ≥10.5 · mid ≥8.5 · dim ≥7 · dimmer ≥5.5 · faint ≥4.5 · accents ≥4.5)
  clear AA by roughly double at the *faintest* tier, on all seven themes,
  Tier-1 enforced against every real text SURFACE (not just `--bg`). Nothing
  owed.
- **The permission prompt does NOT move focus — LOCKED (Kyle, 2026-07-22).**
  His words: *"it violates normal browser behavior - don't do it."* The final
  shape is assertive announcement + Tab-reachable Allow/Deny. Never
  re-propose focus moves here, including "safe" conditional variants
  (move-only-when-input-empty, jump-to-bar shortcuts) — those were presented
  and declined.
- **Kyle's standing a11y rule:** *"i'm down with EVERY standard pattern for
  accessibility we can add so long as it doesn't change the interface or
  functionality for non-disabled users, only then do i want to be
  consulted."* Also in assistant memory as [[a11y-standing-rule]].
- **The screen-reader walk is fully automatable on this box** — no human ear
  needed. Recipe (Orca `--debug-file` + CDP via the claude-in-chrome
  extension + AT-SPI `doDefault` foregrounding + filtering the CLI's
  terminal-title flood out of the log) is in [[orca-testing-mirafold]].
- **Other screen readers deferred post-launch, Kyle's call 2026-07-22.**
  NVDA/JAWS (Windows) and VoiceOver (Apple) were never walked — each needs
  hardware we don't run. Not a launch gate; A.4's statement already words the
  scope honestly ("most thorough with Orca on Chrome").
- The automated regression guard for all of it is **C.2** (axe-core, Tier 3).

- [x] **A.1 — Live regions: streaming agent output is announced** — done 2026-07-21. → PLAN-ARCHIVE.md.
- [x] **A.2 / A.2b — Every control is a real control (incl. Onboarding)** — done 2026-07-20. → PLAN-ARCHIVE.md.
- [x] **A.3 — Focus management + the manual keyboard pass** — done 2026-07-21. → PLAN-ARCHIVE.md.
- [x] **A.3b — FleetView rows: nested interactive controls** — done 2026-07-20 (stretched-link card pattern, resolved by the standing rule above). → PLAN-ARCHIVE.md.
- [x] **A.4 — Public accessibility statement** — drafted + wired 2026-07-21 in `mirafold-site`; claims **partially conformant, self-assessed**, with known limitations named. Footer-linked on every page + in `sitemap.xml`.
  - **⚠ Still open, Kyle's call (flagged 2026-07-21, NOT applied):** dogfooding
    the site through axe found **two real WCAG-AA contrast failures on the
    marketing site itself** — `footer > p` `--faint #58627a` on `--bg-2` =
    **3.12:1** (fix `#798195`) on *every* page including the accessibility
    page's own footer, and index's `.copy` button `--dim #7b8698` on
    `--surface-3` = **4.32:1** (fix `#838d9e`). Both are shared brand tokens,
    so recolouring them is a visible change to Kyle's site design — outside
    the standing rule, his sign-off. Tracked in `mirafold-site/PLAN.md`.
---

## Phase KB — Keyboard power-user layer (opened 2026-07-22; candidate pre-launch, the vim-user wedge)

Distinct from Phase A: that phase is the *accessibility floor* (WCAG 2.1 AA —
can you reach everything by Tab). This is the *ceiling* — never needing the
mouse OR the Tab-slog: fast, discoverable keys plus a prompt box that speaks
vim. It targets exactly Mirafold's terminal-native wedge, so it reads as
identity, not polish. Not yet sequenced against C/D/etc.; steps get written
(Goal/Build/Files/Done-when) when Kyle slots it. Full breakdown + the
post-launch depth live in **POST-RELEASE.md** ("Keyboard power-user layer");
this note is the pre-launch pointer.

The two governing constraints (both Kyle's, 2026-07-22) turn out to point at
the *cheapest* architecture, not a costlier one:

- **Nothing changes for non-vim users** — verbatim Kyle's standing A.3 rule.
  Satisfied structurally: prompt-box vim mode is an opt-in setting, **default
  off = today's exact `<textarea>`, element unswapped**; global shortcuts fire
  **only when focus is not in the prompt**, so a user who lives in the prompt
  never triggers one.
- **Mirror how vim users already work in a terminal** — so the decisions are
  easy. The same focus-state rule *is* the modal mapping: typing a prompt =
  insert mode, `Esc` out = normal mode where shortcuts wake. ~80% of "modality"
  falls out of focus state with no mode system invented.

Candidate pre-launch slice (the identity part, ~1.5–2 wks, mostly hung off
machinery that already exists — the overlay pattern, `useFocusTrap`,
`useEscapeKey`, and the bus actions `interrupt`/`create`/pin):

- **Focus-visibility fixes** (hours). Reveal-on-hover controls must also reveal
  on keyboard focus. Confirmed gap: `.pin-btn` is `opacity:0` (styles.css:187)
  revealed only by `:hover` (styles.css:191) — a keyboard user Tabs onto an
  invisible button (WCAG 2.4.7). Add a `:focus-within`/`:focus-visible` reveal;
  sweep for siblings. Invisible to mouse users → under Kyle's standing rule.
- **`?` shortcuts overlay** (~½ day) — static keymap list, reuses the overlay +
  focus-trap machinery.
- **Command palette + core bindings** (~2–4 days) — a shell-owned overlay
  (leader `:` or Space) calling the existing bus actions; gated to
  focus-not-in-prompt.
- **Prompt-box vim mode** (~4–6 days, the long pole and the only real
  integration risk) — mount CodeMirror-with-vim in place of the textarea *only*
  when the setting is on, preserving auto-grow, Enter-to-send, the `❯` glyph,
  and all seven themes.

The ~3 small picks the terminal doesn't answer for you: Enter-in-normal-mode
(→ always send from the prompt), leader key (`:` vs Space), and focus-gated
shortcuts (v1) vs a true app-wide normal mode (post-launch). None
controversial.

---

## Phase C — CI/CD (opened 2026-07-20; ✅ COMPLETE 2026-07-21)

Before this phase there was no CI in any repo — verification was Kyle running
the three suites by hand. Both steps done 2026-07-21 and **both PRs merged
2026-07-22** (`mirafold/mirafold#1`, `mirafold/mirafold-relay#1`); full step
bodies + dated history → PLAN-ARCHIVE.md ("Moved 2026-07-24").

- [x] **C.1 — Stand up CI** — GitHub Actions live on both code repos. Shell
  (Node 22/yarn): typecheck + Tier 1 on every push, a separate integration job
  (Tier 2 + Tier 3 headless Chrome) **on PRs only** (Kyle's call, `a771110`).
  Relay (Node 20/npm): typecheck + unit. Actions on v5 both repos.
- [x] **C.2 — axe-core in Tier 3** — `axe-core@4.10.2` scans 5 surfaces, fails
  the build on serious/critical; verified it catches a real regression, then
  reverted. Exceptions list empty. This is Phase A's regression guard.

**Standing rules and carried-forward items:**

- **No provider credential ever goes in repo secrets — absolute.** Tier 4 is
  excluded from CI for exactly this reason; the harness forces credentials
  empty → `MockSession`, so there is no API spend and no live-model flakiness.
  Both workflows run `permissions: contents: read`.
- **Deployment is manual-dispatch only — Kyle's standing directive**, and it
  governs all future CD work in every repo (his job's `on-prod.yml` pattern: a
  human clicks *Run workflow* and picks the ref; nothing deploys on
  push/merge/schedule). Scaffolded for the relay in
  `genui-relay/.github/workflows/deploy.yml` (`9162fa1`), with the R.5d
  staging/production environment dropdown on it.
- **Owed at the public flip (carried in R.5b):** re-enable the cross-repo relay
  itest. A single-repo checkout of a *private* sibling can't resolve
  `../genui-relay`, so it is excluded via `tsconfig.ci.json` + a Tier-2 `find`
  filter — both documented with the drop-them-at-the-flip path. It still runs
  locally.
- **Branch protection is BLOCKED by GitHub's paywall** — classic protection and
  rulesets both 403 ("Upgrade to GitHub Pro or make this repository public")
  on free-plan private repos. Kyle's intended shape when available: required
  checks (unit + integration), NO review requirement (solo dev), admin bypass
  for direct pushes, no force-push/delete. Options: pay (org → GitHub Team) or
  wait for the public flip, when it's free. Revisit at R.5b.
- **✅ CI FLAKE FULLY RESOLVED 2026-07-23** (PR `mirafold/mirafold#5`). The
  "quarantine + fix" call became just FIX — nothing quarantined. Surface was
  wider than the 3 named: **six** flaky tests, **three** root causes, each
  reproduced under `taskset -c 0` + CPU stress before fixing. (1) *Log-vs-socket
  race* (4 tests) — asserting `daemon.logs()` right after a wire event, but the
  log rides stdout's pipe while the event rides the socket → new
  `Daemon.waitForLog` helper, whole suite swept. (2) *bang-kill pre-attach* —
  killed before the PTY child attached; now waits for output. (3) *axe animation
  sampling* — fleet rows sampled mid-`rise` read as low-contrast;
  `assertAxeClean` settles animations first. (4) *RemoteClient unhandled
  rejection* (subtlest) — a wrong-code connect's close rejected `hsDone` before
  it was awaited, crashing the whole test process (22/40 under stress; the
  daemon was provably innocent) → `hsDone.catch(()=>{})`. **NO product code
  changed — every fix was in test/harness code.** Proven by repeated green CI
  cycles on the real runner, not a single pass.
---

## Phase D — Decompose the Codex adapter (opened 2026-07-20)

`server/adapters/codex.ts` is **824 lines** and carries at least five separable
concerns. For scale, the other two real adapters are 499 (`claude-code.ts`) and
382 (`gemini-cli.ts`) — it isn't merely the biggest, it's nearly the other two
combined, and it grew again on 2026-07-20 (provider binding + the notice fix).
Size alone wouldn't justify a step; the reason it's worth doing **now** is that
two separate 2026-07-20 bugs both lived in the seams between those concerns —
the engine-default lookup didn't know what the provider binding had decided,
and a non-fatal engine item was classified where the fatal ones are handled.
Concerns that can't see each other's decisions are exactly what splitting makes
visible.

Do it now, before Phase F widens the adapter's event vocabulary further: every
type added to `handleEvent`/`onItem` afterwards makes the split more expensive.

**This is a pure refactor — zero functional change.** It is well protected:
298 Tier-1 tests, the Tier-2 and Tier-3 suites, and the Tier-4 live tier, all
green as of 2026-07-20 (318 Tier-1 as of 2026-07-23).

**2026-07-23 — pre-launch refactor pass (unplanned maintenance, whole repo)**
landed a behavior-preserving sweep that overlaps this phase's spirit without
executing it: server-side, an `errText()` helper in `adapters/types.ts`
replaced the 9 copy-pasted unknown-error idioms, `claude-code.ts`'s `pump()`
had its 50-line `system` case extracted to `handleSystemMsg()`, `codex.ts`
gained `finishTool()` (the 4× announced-delete + tool_result emit), and
`connection.ts`'s module-load `OFFERABLE` now reads the static
`ADAPTER_AGENTS` list instead of running full credential detection at import.
Web-side: `ModalCard.tsx` absorbed the modal scaffold shared by
ConnectDevice/ThemePicker/Onboarding, `useArmedConfirm` the two-click
end-session state (StatusBar + FleetView), `DiffLines` the duplicated diff-line
JSX (ToolBlock + registry Diff), plus one real bug fixed: both Onboarding
callers passed a fresh inline `onRefresh` arrow, so the picker's 3s re-probe
poll was reset on every parent render and effectively never fired — both now
pass a `useCallback`-stable function. README §11's accepted-duplication list
was honored throughout (worker() loops, listener/emit boilerplate, RenderZone
upsert twins all untouched). All tiers green after (318 / 86 / 37).

- [ ] **Step D.1 — Split `codex.ts` along its existing seams**
  - Goal: no file over ~400 lines, each concern findable by name, and
    `CodexSession`'s public surface (the `AgentSession` contract) unchanged.
  - Build: extract along the seams already visible in the file —
    1. **Provider + model binding** — `providerBinding`, `firstPartyOpenAI`,
       `needsEngineDefaultModel`, `applyEngineDefaultModel`. This is the
       cluster that produced the 2026-07-20 model-binding bug; it deserves to
       be one named unit with its own tests.
    2. **The slash-command surface** — `runModelCommand`, `runEffortCommand`,
       `setThreadModel`, `setThreadEffort`, `restartThread`, plus the `EFFORTS`
       / `EFFORT_DESC` tables.
    3. **Event → WireMsg mapping** — `handleEvent` / `onItem`, the largest
       single block and the one Phase F will grow.
    4. **The rollout model lookup** — `resolveRolloutModel` + `rolloutDateDir`,
       already standalone exported functions with no `this`, so this one is a
       move rather than an extraction.
    5. **Prompt constants** — `CODEX_DEFERRED_TOOLS_ADDENDUM` and friends.
  - Keep `codex.ts` as the class + its lifecycle; the extracted units should be
    importable and testable without constructing a session where possible.
  - Files: `server/adapters/codex.ts` → new siblings (`codex-binding.ts`,
    `codex-commands.ts`, `codex-events.ts`, `codex-rollout.ts` or as the seams
    suggest); `server/adapters/codex.test.ts` imports follow.
  - Done when: `yarn typecheck` clean; `yarn test` still **318 pass / 0 fail**
    (count as of 2026-07-23)
    with no test rewritten to accommodate the move (import paths may change,
    assertions may not); `yarn test:server` and `yarn test:e2e` unchanged;
    `yarn test:live` still 2 pass / 1 skip; and one real subscription turn plus
    one real OpenRouter turn verified by hand, since those are the paths the
    binding cluster governs and no mock covers them.

---

## Phase F — Fidelity gap-close (from the 2026-07-07 parity evaluation)

Source: a parity evaluation of each adapter against its engine's **full** event
vocabulary — `@anthropic-ai/claude-agent-sdk@0.3.201` (38-type `SDKMessage`
union; the adapter handles 4), `@openai/codex-sdk@0.142.5` (vocabulary 100%
covered; the gaps are behavioral), `@google/gemini-cli@0.49.0` (stream-json
emitter read in the installed bundle) — then live-probed cheaply (Claude
subscription login, Codex ChatGPT login $0, one small Gemini flash call).
Every claim below marked "observed" was seen in a live run, not inferred.
F.1–F.4 are small, adapter-scoped, additive-protocol-only — sequence them
anywhere, including as pre-launch polish. F.5–F.6 are engine-surface
migrations: post-launch, demand-gated. Faithful-skin rule throughout: each
fix restores what that agent's *terminal* user already sees — nothing invented.

- [x] **Step F.1 — Slash-command output renders** — done 2026-07-08; buffered assistant text (e.g. `/context`) paints exactly once without double-rendering a streamed turn. → PLAN-ARCHIVE.md.

- [x] **Step F.2 — System-notice line (the UI must not lie in degraded service)** — done 2026-07-12; one additive `notice` WireMsg (retry | compaction | rate_limit | refusal) mapped from five SDK events in the claude adapter, drawn as a dim persistent notice line in RenderZone (silent on plain rate-limit `allowed`, so no spam). → PLAN-ARCHIVE.md.

- [x] **Step F.3 — Honest model label in the status bar** — done 2026-07-08; the adapters read the engine-resolved model (`system/init`, gemini `result.stats.models`) into `usage.model` instead of "default"/"auto". → PLAN-ARCHIVE.md.

- [x] **Step F.4 — Gemini honesty pass** — done 2026-07-08; a stderr-only non-zero exit surfaces as an `error` WireMsg instead of a silent turn. → PLAN-ARCHIVE.md.

- [x] **Step F.9 — Gemini session-id self-heal (a session-bricking latent bug, found in the 2026-07-23 refactor recon)** — done 2026-07-23. The adapter set `started = true` before the child confirmed anything, so a first turn that failed before Gemini persisted the session file (bad auth, missing binary, an early kill) left every later turn spawning `gemini --resume <id>` against an id that was never saved — which the CLI treats as `FATAL_INPUT_ERROR` (exit 42, zero stdout events, verified in the installed v0.51.0 bundle's `resolveSessionId()` AND by a credential-less sandbox repro): the Mirafold session was permanently dead, erroring on every prompt. Fix: the close handler now flips the id mode when a turn exits 42 with no events — the failure itself proves the flip direction ("no such session" ⇒ create next turn; the mirror fatal, `--session-id` "already exists" ⇒ resume next turn) — so recovery costs one failed prompt instead of the session. No timing assumptions about when Gemini persists, no stderr string-matching (exit code + zero-events is the whole signature). Three Tier-1 tests through the real spawn path: the brick sequence heals, the mirror heals, and 42-with-events (a different input error) does NOT flip.

- [x] **Step F.7 — Codex resolved-model label (closes F.3's codex gap)** — done 2026-07-16; the adapter reads the engine-resolved model from Codex's own rollout record (keyed by thread id; bounded poll; failure-silent; a configured `CODEX_MODEL` wins). Side-finding folded into F.5's rationale: the SDK vendors an older codex binary than the user's terminal, so SDK sessions can default to an older model. → PLAN-ARCHIVE.md.

- [x] **Step F.8 — `!` terminal parity + hardening** — done 2026-07-17 (Kyle: "we must never hide ANYTHING"); bang `cd` persists inside the workspace (EXIT-trap cwd handoff; an escape resets with the terminal's own notice), silent success renders "(completed with no output)", and the transcript reaches the agent immediately as its own turn (the engine's internal shell can't follow a bang `cd` — the one disclosed divergence). Same-day hardening: 0700 handoff dir, FIFO-stall gate, closing-fence escaping, 400ms bang throttle. F.3 extended: `session_created` carries the model label (status bar + fleet show agent → model from attach). SECURITY.md disclosure note queued under R.7. Tests in all three tiers. → PLAN-ARCHIVE.md.

- [ ] **Step F.5 — Codex app-server migration (approvals, streaming, visible
  reasoning)** *(post-launch, demand-gated — the big one)*
  - Goal: close the three live-confirmed divergences from terminal Codex, all
    rooted in the SDK's headless `exec` surface: (1) **no approval round-trip**
    — observed: in a cwd outside the user's trusted projects, headless Codex
    runs read-only with approvals disabled and *narrates* a refusal where the
    terminal would prompt; trust is location-dependent and invisible (our
    `workspace/` sessions work only because they sit under the trusted repo
    path). (2) **No streaming** — the reply lands as one buffered
    `item.completed` lump. (3) **Reasoning can be entirely absent** — observed:
    79 reasoning tokens spent, no `reasoning` item emitted at all.
    (4, added 2026-07-16 via F.7) **the SDK vendors its own codex binary**, so
    sessions can run an older default model than the user's terminal codex —
    observed: vendored 0.142.5 → gpt-5.5 vs terminal 0.144.5 → gpt-5.6-sol;
    the app-server surface drives the system codex and closes this too.
  - Build: drive Codex's **app-server** (JSON-RPC 2.0, the surface behind the
    VS Code extension — see codex.spike.md's original event table):
    `requestApproval` → `permission_request` (the browser bar + wire machinery
    already exist), `item/agentMessage/delta` → `text_delta`,
    `item/agentReasoning/delta` → `thinking_delta`, live command output.
    Inherit-don't-invent still governs: surface Codex's own approval
    semantics, never re-implement policy. Contract note (2026-07-08 design
    review): this is the first step to hit the binary-permission wall —
    `resolvePermission(id, boolean)` on the seam and allow/deny-only on the
    wire can't express "approve for session" or edited input; widening both
    (additively: an optional `options` field on `permission_request`, a
    richer response variant) is part of this step's work, not a surprise.
  - Done when: a gated command in an untrusted cwd raises the permission bar
    and proceeds on allow — exactly what the terminal does — and text/
    reasoning stream token-wise.

- [ ] **Step F.6 — Gemini ACP migration (thinking + approvals)** *(post-launch,
  demand-gated — the F.5 analog)*
  - Goal: terminal Gemini visibly shows its thinking; the stream-json emitter
    forwards only `text` parts (confirmed in the bundle source AND live with a
    forced-reasoning prompt: no thought events on a thinking-capable model).
    Approvals hit the same headless wall as Codex. The P.5 spike already named
    ACP as the upgrade path.
  - Build: drive `gemini --acp` (Agent Client Protocol, the surface Zed uses):
    `agent_thought_chunk` → `thinking_delta`, `session/request_permission` →
    `permission_request`. stream-json remains the fallback surface.
  - Done when: a Gemini session shows the folding thinking block live, and a
    gated tool raises the permission bar instead of failing silently.

---

## Phase Q — Test-suite bite (from the 2026-07-08 test-quality review)

Source: a critical read of all 28 test files in all three tiers against the
code they guard, asking one question — *which load-bearing behaviors could
regress tomorrow without any test failing?* The verdict on the existing suite
was good: the relay crypto tests are genuinely adversarial (tamper, replay,
reorder, reflection, wrong-key all asserted to fail), the relay itests prove
via a tap that the operator sees only ciphertext, the bang-secret test checks
absence from streams + replay + logs, and the adapter tests pin the full
event→WireMsg grammar including error paths. Almost nothing passes vacuously.
The gaps concentrate where the browser renders the trusted-shell boundary
(the pre-launch item is **Step R.4e** above) and in a handful of server
invariants held only by convention. Every step below is **test-only** — no
product code changes — and keeps the zero-test-deps rule (node:test + tsx;
DOM behavior is proven in Tier-3 headless Chrome, never jsdom). Sequence
anywhere; each is independent.

- [ ] **Step Q.1 — Render pipeline fails soft, and update-in-place is real
  in the DOM**
  - Goal: Step 1.4's promise — "a malformed instruction must never break the
    UI" — has three fallback layers in `RenderBlock.tsx` (unknown component,
    schema-failing props, crash → error boundary) and **zero tests**; the mock
    only ever sends valid renders. Client-side update-in-place is proven only
    at the wire (`session.itest.ts` asserts five frames share one id) — no
    test asserts the DOM holds *one* checklist rather than five, so a
    regression in `RenderZone`'s `findIndex` update path passes every tier.
    The pin machinery (pin → dock, live update while pinned, pins re-binding
    across a `zone_reset` replay) — a shell-owned affordance — is untested.
  - Build: a "render something malformed" mock hook (unknown component name +
    schema-invalid props for a known one), then Tier-3 assertions: the
    fallback block paints with the raw props visible, the zone keeps working
    afterwards; the existing checklist e2e additionally asserts exactly one
    todo-list block in the DOM; a pin e2e: pin a component, drive an update
    (dock copy repaints), reload mid-session (pin survives the replay),
    unpin returns it to the transcript.
  - Files: `server/adapters/mock.ts` (malformed hook),
    `server/testing/app.e2e.ts`.
  - Done when: malformed instructions visibly degrade instead of crashing in
    a real browser, the five-frame checklist paints one block not five, and a
    pinned widget stays live across an update and a reload.

- [x] **Step Q.2 — Freeze the wire protocol in executable form** — done 2026-07-12; mapped-type golden fixtures for every WireMsg/ClientMsg variant: a missing fixture fails typecheck, a reshaped frame fails loudly — both teeth verified by experiment. → PLAN-ARCHIVE.md.

- [x] **Step Q.3 — Ring-buffer eviction and the resume boundary** — done 2026-07-12; five Tier-1 tests pin the exact eviction window and the `canResume` edge, verified to bite by mutation. → PLAN-ARCHIVE.md.

- [x] **Step Q.4 — Hostile-client sweep of `connection.ts`** — done 2026-07-12; a real-daemon garbage sweep of every ClientMsg case found + fixed two real bugs (a null frame could crash the whole daemon on the local path; the bang-id guard coerced non-strings into launching bangs). → PLAN-ARCHIVE.md.

- [x] **Step Q.5 — Pin the `.env` guard's edges** — done 2026-07-12; traversal + cross-cwd denials pinned across all four guarded readers, non-vacuous by weakening the guard. (Symlink bypass stays the documented accepted residual.) → PLAN-ARCHIVE.md.

- **WATCH ITEM (2026-07-24): the follow-tail re-arm race** — seen once on the
  CI runner (app.e2e.ts "re-follows once back at the bottom", sat 188px above
  the tail), green on rerun and on every local run; ROOT-CAUSED same day, fix
  deferred. Mechanism: re-arming depends on `use-follow-tail.ts`'s `onScroll`
  measuring within `BOTTOM_SLACK_PX` (24) of the bottom, but scroll events
  fire a frame after the scroll — under load the stream can paint >24px in
  that gap, so a reader (or the test's single programmatic jump) landing at
  the bottom mid-stream measures as "not at bottom" and follow never re-arms.
  A REAL product race, not only test fragility — narrow, and a human recovers
  by scrolling again, which is why it's a watch item not a blocker. Proposed
  fix shape when picked up: arm on INTENT like detach already does (a
  downward wheel/touch ending near the bottom re-arms), so re-arming stops
  depending on winning a paint race; the hook's two locked decisions
  (2026-07-20 trace) must be re-read first. The test's single jump + single
  sample then stops being timing-sensitive on its own.

---

## Phase S — Theme system: six themes at launch (✅ COMPLETE 2026-07-16)

Six themes ship in the launch build — Light, Dark, Solarized Light,
Solarized Dark, Gruvbox Dark, Dracula — on plumbing that makes every later
theme a **one-CSS-file + one-manifest-row addition** (loading is glob'd,
swatches parse the theme file, Tier-1 guards sweep the directory — proven
by construction in S.5/S.6). All six steps done 2026-07-16, final parity
178/74/24; full charter + step bodies → PLAN-ARCHIVE.md. The **standing
rules that outlive the phase**:

- **The light/dark pill does not change AT ALL — LOCKED (Kyle, stated
  multiple times; re-affirmed emphatically 2026-07-16 after an "Auto"
  third state was misrecorded into S.3's original text and struck).** Same
  look, same two positions, same behavior — no tri-state, no Auto, no
  `prefers-color-scheme` following, no visual tweak of any kind. Its two
  positions select the two theme slots (light/dark), which with default
  slots is indistinguishable from before. The settings gear (S.4) is the
  phase's ONE new chrome affordance. Any future change to the pill
  requires a new, explicit decision from Kyle — never infer one from
  adjacent work.
- **Semantic tokens stay the vocabulary; native CSS only; Base16 is only
  the porting recipe.** The 41-token contract, the 7 pinned
  `--code-*`/`--diff-*` tokens (code/diff surfaces stay dark universally),
  and the slot→token recipe live in `web/src/themes/manifest.ts`, guarded
  by `themes.test.ts`. Themes never come in pairs; every theme is
  standalone, labeled `light` or `dark` only to answer which side of the
  pill selects it.
- Adding a theme: one file in `web/src/themes/` + one manifest row via the
  recipe. Before accepting community theme PRs at the public flip, land
  R.7's token-VALUE guard hardening.

---

## Phase L — Local models: zero-friction (ergonomics on top of Phase P)

Goal of the phase: someone running a local LLM uses their agent in Mirafold
as easily as a cloud user — inference never leaving the machine. **Local isn't
a Mirafold feature; it's a property of the agent.** A terminal agent that
can point at a local endpoint (e.g. Codex against a local OpenAI-compatible
server — Ollama / vLLM / LM Studio) already runs locally; Mirafold just
re-skins that agent, so a "local" session is just that agent configured for
localhost — **no LiteLLM, no shim.** This phase is only the ergonomics and
honest guidance. (Prereq: Phase P, and Step 1.4's render fallback so small
models degrade to styled text, not broken UI.)

**Posture (locked 2026-07-05):** best-effort support for *whatever* endpoint a
user's agent points at, with an honest heads-up that small/unusual local models
may misfire (tool calls, loops) and degrade to plain text. Don't gate on a
curated model list. Agent- or model-specific niceties (tuned prompts,
capability toggles) for the big popular ones can come **later**, as demand
shows which matter — not a launch prerequisite.

- [x] **Step L.1 — Documented local path** — done 2026-07-07; `docs/local-models.md` (Claude Code→Ollama, Codex→local providers), facts verified vs vendor docs and live on CPU. → PLAN-ARCHIVE.md.

- [ ] **Step L.2 — `--local` easy mode (post-M2, demand-gated)**
  - Goal: one command instead of a couple minutes — build only if setup
    friction shows up in the tracker.
  - Build: `npx mirafold --local` detects a running Ollama/LM Studio, lists
    installed models, and configures a local-capable agent to use it with sane
    defaults (no proxy). Status bar shows the active agent/model.
  - Note (2026-07-17): Phase N lands the detection substrate this step
    reuses (`server/local-models.ts` — the probe, dialect tagging, model
    catalogs) and the in-UI picker; what remains of L.2 is only the CLI
    flag ergonomics, still demand-gated.
  - Done when: on a machine with Ollama + a supported model, `--local` cold
    start reaches a working session with zero manual config.

- [ ] **Step L.3 — Per-session provider (stacks on 4.2, optional)**
  - Goal: mix providers in one daemon — Claude for the hard refactor, a
    local model for the log-tailing session.
  - Build: `create` (Step 4.2) accepts an optional `provider`/`model`;
    registry passes per-session env/config to the Agent SDK session; fleet
    view (4.6) shows each session's model.
  - Done when: two concurrent sessions run on two different providers and
    the fleet view distinguishes them.
  - Note (2026-07-10): the fleet view already distinguishes sessions by model
    (the model column, done this session). A user-testing pass surfaced the
    matching onboarding need — lead with the model/backend *source* (make
    local/open-source models first-class; let Codex pick subscription vs API
    key) — which folds into L.2/L.3, since it needs exactly this per-session
    provider/model choice.
  - Note (2026-07-17): **Phase N delivers most of this** — per-session
    backend choice at onboarding (N.5 is exactly the "registry passes
    per-session env/config" build). What remains of L.3 afterward is only
    whatever mixing ergonomics Phase N's shipped form still leaves wanting.

---

## Phase E — Explorer (opened + ✅ COMPLETE 2026-07-24; Kyle-directed, promoted from POST-RELEASE.md)

The "Folder & file & diff view" intake entry, built: a shell-owned,
**read-only** browser of the session's working tree — file tree, file
contents, git diffs. All five steps shipped 2026-07-24 plus a
behavior-preserving refactor and a security audit; tiers **350/95/41**.
PRs #7 (E.1+E.2), #9 (E.3), #10 (E.4+E.5), #12 — all merged to main. Full
design charter, step bodies and dated status → PLAN-ARCHIVE.md ("Moved
2026-07-24").

The governing principles, which any later work here inherits:

- **Shell-owned and read-only.** The agent paints nothing here — same trust
  rule as the permission bar. No editing in v1; that persona belongs to the
  embedded-terminal-pane idea (POST-RELEASE.md).
- **Wire-native, per-viewport.** Additive protocol types over the existing
  WebSocket, never HTTP — remote/relay viewports have no HTTP path to the
  daemon, so wire-native means the phone gets this by construction. Replies
  carry a client-minted echoed `id`; never broadcast, never replay-buffered,
  no `seq`.
- **Jailed.** Every path resolves through `inside()`'s realpath containment
  against `entry.cwd` (the immutable session root, never `bangCwd`), with the
  `.env`/`.env.local` secret denial on top.
- **Diffs are `{before, after}`, diffed client-side** (`git show HEAD:path` vs
  the working tree, through the existing `diffLines` LCS differ) — hunk text
  never crosses the wire, no `@@` parsing anywhere.
- **Two presentations, one component set** (Kyle's calls): desktop = a
  collapsible LEFT side panel; phone (≤640px) = full-screen drill-in layers,
  explicitly NOT a bottom sheet. This claims the split-pane layout slot the
  embedded terminal pane will later share.

Accepted v1 limits, on purpose: ignored files are invisible in-repo
(`ls-files --exclude-standard` semantics); independently-capped diff sides can
overstate changes past the cap (truncation markers render prominently); full
`role="tree"` arrow-key grammar is deferred to Phase KB territory — buttons in
nested lists are tabbable and axe-clean.

**Security audit of the whole delta (2026-07-24): no exploitable
vulnerability.** One hardening landed same session (`FS_TREE_MAX_NODES` bounds
the non-git walk — a workspace of many empty directories could otherwise be
walked unbounded and synchronously), and one terminal-parity read-scope note
was recorded in SECURITY.md's known-trust-decisions (the Explorer's
`.env`-basename read scope matches the existing `Read` tool / `!cat`; the
daemon's own `.env` stays protected and the Explorer is narrower).
**Deferred, evidence-gated:** make the non-git walk asynchronous (yield to the
event loop) only IF the node cap ever proves too blunt — likely unnecessary.

**Kyle-directed UI polish pass (2026-07-24 evening, iterative):** the desktop
frame got a VS Code-style **activity bar** — a permanent thin strip flush with
the window's left edge whose files icon toggles the panel (replacing the
status bar's `files` button); the tree now leads with the **checked-out root
as its top node** (name only, full path in its tooltip — the path header row
is gone); the panel width is **fit-to-content** (widest visible row + a little
air, capped at the old 340px/42vw, 140px floor); refresh floats pinned at the
panel's **bottom-left**; back lives in the file view's path bar. Verified per
round in headless Chrome by measurement (geometry probes), not eyeballing —
the round-3 lesson: the icon's SVG box, the UA button padding, and the
`.shell` gutter each silently ate a "fix" until measured from the window edge.
Same session: a behavior-preserving refactor (ActivityBar extracted beside
BangBar; `--gutter-left/right` + `--content-air` CSS vars replace the
duplicated gutter expressions) and a delta audit — no exploitable findings; a
hostile `<img onerror>` filename demonstrated inert (React text escaping).

**2026-07-25 amendment (Kyle-caught deviation):** the polish pass above made
the activity bar permanent at ALL widths — but the locked design (the charter
above, and the 2026-07-24 scope lock before it) always said phone entry =
files icon in the status bar. On a 390px screen the 46px always-on strip was
"way too much precious screen real estate" (Kyle). Restored same day
(`d8abc62`): the rail is desktop-only (≤640px hides it; shell + prompt box
run full-width again); the phone toggle is `.sb-files` at the status bar's
far LEFT, boxed off by its own separator line (the rail's border folded into
the row), one notch outside home — Kyle's chosen shape over between-home-and-
new, auto-hiding rail, FAB, and bottom-nav alternatives. Rendered only on
phone via `useIsPhone`, so desktop DOM keeps home as the bar's first control
(the locked 2026-07-16 order). Drill-in, focus trap, and focus-return carry
over untouched; the phone e2e opens via `.sb-files` and asserts the rail is
`display: none`. Deployed to app.mirafold.com same day (Pages auto-build,
bundle `index-BG3GNY9U.js` confirmed live).

Post-v1 depth (editing, fs-watcher, syntax highlighting, changed-files
grouping) stays parked in POST-RELEASE.md.
---

## Phase M — Mission control (opened + ✅ COMPLETE 2026-07-24; Kyle-directed, promoted from POST-RELEASE.md)

The "Cockpit fleetview" intake entry, built: FleetView (4.6) grown into a true
cockpit — at-a-glance live state of every session, and acting on sessions from
the grid rather than only entering them. All five steps shipped 2026-07-24;
tiers **357/94/47**. **PR `mirafold/mirafold#8` merged to main** (CI Tier
1/2/3 + CodeQL green), follow-up passes via **PR #11**. Full design charter,
step bodies and dated status → PLAN-ARCHIVE.md ("Moved 2026-07-24").

What shipped: registry-derived live `SessionMeta` (activity + since, pending
permission queue, session usage, `createdAt`) on the existing per-viewport
`sessions` snapshot; three sessionId-addressed `ClientMsg` acts
(`answer_permission`, `interrupt_session`, `prompt_session`); enriched rows
with activity readout, compact usage, an in-place Allow/Deny line, an armed
two-click stop and a per-row quick prompt; phone-width folding; and the fleet
TAB as a signal (needs-you badge + counted title) plus the per-row viewport
count.

The governing principles, which any later fleet work inherits:

- **Shell-owned end to end.** Same trust rule as the permission bar: agent
  output never paints here, and every engine-derived string on a row renders
  as inert plain text — never markdown, never HTML.
- **Extends the watch_sessions path, additively.** Live state rides optional
  `SessionMeta` fields on the existing snapshot (never broadcast, never
  replay-buffered, no `seq`); grid acts are new sessionId-addressed
  `ClientMsg` types on the `end_session` precedent. No new stream, no new
  transport.
- **Agent-neutral by construction** — every field is derived in the registry
  from the WireMsg stream it already fans out. No adapter cooperation, no
  per-agent code.
- **Grid acts = viewport acts, same gates.** Acting from the grid grants
  nothing a local viewport couldn't do by attaching. The one carried gate: a
  REMOTE (relay) watcher may not drive a subscription-backed session (R.4i),
  so quick-prompt and permission-answer are refused when
  `remote && !allowedOverRelay(kind)`; interrupt stays ungated, like
  `end_session` (teardown, not model use).
- **Stable rows, needs-you first** (Kyle's ordering call): rows hold creation
  order so eyes can park on a session; sessions awaiting permission surface to
  a group at the top. The recency sort is retired on this page.
- **The archived-session fleetview stays unprecluded** — the `sessions`
  snapshot remains live-only; a future archived fleetview arrives as its own
  additive message + a second page section, never by reshaping this one.

Accepted v1 limits, on purpose: no live output preview on rows (Kyle's call);
no one-click default new-session (the picker stays the only create); usage
mirrors the status bar's exact rule (per-turn tokens summed, cost taken
cumulative); elapsed time ticks client-side from `since`. *(A third v1 limit —
permission-queue status stickiness hiding a second concurrently-pending
request — was hit in real use and FIXED in the 2026-07-24 evening pass below.)*

**Post-merge quality passes (2026-07-24, PR #11):** a real bug behind the
fleet.e2e ordering flake — `.fleet-activity` was the row's only shrinkable
column with no floor, so a full row flex-crushed the live readout to invisible
(`min-width: 12ch`; reproduced 8/1 under a 2-core pin, 5/5 green after); a
behavior-preserving refactor (FleetView rows decomposed into SessionName /
ArmedButton / PermissionLine / QuickPromptLine, `captureCockpit` + `actTarget`
extracted server-side, the Phase M CSS consolidated); and an `/audit` whose
**one real ship-time finding** was fixed — the fleet snapshot capped the
permission detail to 200 chars while the in-session bar shows it whole, so a
grid approver could miss a dangerous tail past a benign head. Now carried
whole, pinned in Tier 1 + Tier 2 (pins verified to fail with the cap restored).

**Evening pass (2026-07-24, second session — Kyle-driven cockpit UX + honesty):**

- **Concurrent-permission honesty bug FIXED** (was the accepted v1 stickiness
  limit above; Kyle hit it live — approved one ask, the next two never
  surfaced). Queue entries now live until their OWN resolution: both answer
  paths (grid `answer_permission` AND in-session `permission_response`) route
  through `registry.answerPermission`; unanswered asks age out on the
  adapter's own `PERMISSION_TIMEOUT_MS` clock (server-side `askedAt`, never
  on the wire); terminal states still clear all. Needs-you (ordering, ⚠
  title, tab badge) keys on pending asks OR permission status, so asks
  surviving past the first answer surface to the top.
- **Details disclosure**: activity readout + tokens·cost moved OFF the row
  bar (full working-state rows overflowed their border; volatile inline text
  made the layout jumpy) into a per-row caret-toggled sub-line — the ❯ glyph
  CSS-rotated down/up, one row open at a time, live-updating. Bar keeps the
  stable glance set: dot · name · agent · model · id · status · ago · ⧉ ·
  acts. (Kyle iterated placement live: centered-borderless tried and reverted.)
- **Viewport-count lag fixed**: leaving a session by navigation now closes
  the socket in `pagehide`, so the daemon detaches immediately instead of the
  30–60s heartbeat window; bfcache restores still reconnect. Session idle
  timeout (zero-viewport grace) raised 60min → **4h** (Kyle's call). Both
  rode the parallel session's commits (`bb272da`).
- **/audit (delta-scoped) → one hardening fix landed**: the fleet's
  pending-permission mirror is capped at 25 (oldest evict — closest to
  auto-deny; evicted asks stay answerable at the adapter) so a permission
  flood can't grow watcher snapshots without bound (probe: 500 asks ≈ 1MB per
  snapshot before, 51KB after) — full per-entry detail kept (the earlier
  audit's no-truncation rule). At-cap floods also stop fanning notifies.
- All pinned: Tier-1 registry lifecycle/prune/cap tests + reworked fleet.e2e
  (details-line interaction, phone tap flow, immediate viewport-count drop).
  Tiers at close: **369 / 103 / 51**.
---

## Stretch goals (unscheduled — polish, no milestone gates on these)

Pick one up only when the phases above are quiet.

**Chart-vocabulary investigation (2026-07-10).** A session prompt asked for a
pie chart; the registry `chart` only knows `line | bar`, so the agent fell
back to a sandboxed artifact — correct behavior, but heavier (iframe), outside
the theme tokens, and outside the registry's palette/interaction rules. Survey
of the remaining gaps, ranked by how likely a coding-agent session is to hit
them:

| data shape the agent can't express | today | fill |
| --- | --- | --- |
| part-of-whole (language mix, pass/fail split) | artifact fallback | `kind: "pie"` → S.1 |
| composition over an axis (tokens by model per day) | grouped bars only | `stacked?: boolean` on bar → S.2 |
| long category labels (file paths, test names) | 12-char x-label truncation | `horizontal?: boolean` bars → S.2 |
| distribution (latency histogram) | agent must think to pre-bin | no new kind — teach pre-binning in the bar `.describe()` → S.2 |
| single KPI (coverage %, p95, session cost) | prose in a `card` | new `stat` registry component → S.3 |
| paired numerics / correlation (scatter) | none | defer: needs a numeric-x data shape, rare in-domain — revisit on demand |
| matrix shading (heatmap) | plain `table` | defer with scatter |

Wire-contract check (all additive, nothing reshapes): new *optional props*
(`stacked`, `horizontal`) strip silently on older clients — the R.4h tolerant
schemas' ideal degradation; a new *`kind` enum value* fails an old client's
parse into the Step 1.4 raw-props fallback — legible, and the designed path.

- [ ] **Step S.1 — `chart` kind: pie (donut)**
  - Goal: a proportions ask renders as a native, theme-tokened chart — never
    an artifact fallback.
  - Build: add `pie` to the `kind` enum. Mapping: `x` = slice names,
    `series[0].values` = slice values (validate exactly 1 series for pie);
    fold slices past 6 into "other" so the fixed-slot palette (slot order is
    the CVD mechanism — never cycle) always suffices. Donut rendering with
    direct labels + hover tooltip (the ≥2-encodings rule). Read the dataviz
    skill before writing the renderer, as Chart.tsx did.
  - Files: `server/registry-spec.ts`, `web/src/registry/Chart.tsx` (+
    `Chart.test.ts`, `registry-spec.test.ts`, an `app.e2e.ts` mock turn).
  - Done when: a mock-session prompt for a pie renders a donut in the output
    zone in both themes, and a malformed pie (e.g. 2 series) degrades into
    the raw-props fallback, observed in headless Chrome.

- [ ] **Step S.2 — chart ergonomics: `stacked`, `horizontal`, histogram hint**
  - Goal: composition and long-label asks stop degrading (cramped grouped
    bars, truncated labels).
  - Build: optional `stacked` (bar → cumulative segments) and `horizontal`
    (bars grow rightward; y carries the category labels untruncated) props;
    extend the bar `.describe()` to tell the agent to pre-bin distributions
    into bar buckets.
  - Done when: stacked and horizontal mock turns render correctly, and an
    old-client simulation (parse through yesterday's tolerant schema) shows
    the props stripping to a plain grouped/vertical bar, not a fallback.

- [ ] **Step S.3 — `stat` registry component (KPI tile)**
  - Goal: single-number answers (coverage %, p95 ms, cost) get a glanceable
    tile instead of a sentence in a `card` — the natural pin-dock resident.
  - Build: new registry entry `stat`: `label`, `value` (string — the agent
    formats units), optional `delta` (+/- with good/bad direction), optional
    `footer`; follows the dataviz stat-tile guidance.
  - Done when: a mock turn renders the tile, it pins to the dock, and an
    update-in-place re-send (same wire id) changes the value live.

---

## Post-release ideas (parked — organize after R.7)

The unordered post-R.7 idea backlog lives in **POST-RELEASE.md** (moved out of
this file 2026-07-19 to keep the plan focused on active launch work). Nothing
in it gates any Phase R step.

## Conventions

- TypeScript everywhere; yarn for all package operations.
- The wire protocol is the contract — add message types, never reshape existing
  ones, so each phase is additive.
- API key and any secret stay server-side. Never serialize them into a
  `WireMsg` or send them to the browser.
- The trusted shell (prompt box, socket, credentials) is never rendered or
  controlled by agent output. Treat that boundary as inviolable.
- Comments only where there's a non-obvious constraint (e.g. the iframe sandbox
  threat model) — the code says what it does.
