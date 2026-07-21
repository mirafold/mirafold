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

Phases 0, T, 1, 2, 3, T2, P, G, H, H2, and S are **done** — their steps and full dated
status notes now live in **PLAN-ARCHIVE.md** (moved out to keep this document
focused). Phases G (relay dedup — the sibling repo became the single source)
and H (human legibility) completed 2026-07-15 and were archived the same day.
Phase H2 (legibility follow-ups: `web/src/components/` + the root-doc tidy +
H2.3's removal of the `relay-service/` pointer directory) completed and was
archived 2026-07-15 as well.
Phase 4's completed steps (4.1–4.6, 4.8–4.10) joined them 2026-07-08; its
header stays below with the 4.7 → Phase R pointer. **2026-07-10:** the
fully-complete steps of Phases R, F, and L (R.1, R.3, R.4b–R.4k, F.1, F.3, F.4,
L.1) were archived the same way to lean this file out — each keeps a one-line
`[x]` pointer inline; the full Goal/Build/Files/Status is in PLAN-ARCHIVE.md
("Phase R / F / L — completed steps"). **2026-07-15 (second pass):** the done
steps of Phases K, F, and Q (K.1, K.3, K.8, K.9, K.11, K.12, F.2, Q.2–Q.5)
were archived the same way ("Phase K / Q — completed steps" + the R/F/L
section for F.2). **2026-07-17 (third pass):** Phase S whole (its
standing rules keep a summary block below), the done steps 4.11 / K.5 /
K.7 / F.7 / F.8, and the full bodies + status histories of the
still-open K.4 / R.2 / R.4 (each keeps a compact stub inline) — all under
"Moved 2026-07-17" in PLAN-ARCHIVE.md. **2026-07-19 (fourth pass):** the
whole of the completed **Phase N** (N.1–N.6, onboarding backend picker) and
**Phase V** (V.1–V.3, visual + fidelity gaps) — their full bodies + status
histories under "Moved 2026-07-19" in PLAN-ARCHIVE.md; each phase keeps a
short summary + per-step one-line pointers inline. Only OPEN steps carry
their full body here. Everything below marked `[ ]` is the remaining work.

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
    and the site; validation-window personal liability is accepted, shielded by
    K.5's ToS liability cap + consequential-damages exclusion. **When the
    trigger fires:** form the CA single-member LLC (~$70 + $800/yr franchise
    tax), EIN (free), business bank account, **convert the Paddle account from
    individual to business** (supported flow via `sellers@paddle.com` — a
    re-verification cycle, not a rebuild), swap the entity name into ToS / site
    footer / both LICENSE lines, and file the trademark (K.10) under the LLC.

- [x] **Step K.3 — Provider-terms re-verification** — done 2026-07-15 (+ same-day amendment); every row pinned to a dated primary source: the Anthropic ban verbatim, Gemini individual-account service ended 2026-06-18 (API keys continue; Antigravity succession check → R.6), and the codex row first flipped to blocked (no written permission exists), then re-flipped by Kyle to allowed-locally as a disclosed gray area — locking the standing **disclosed-uncertainty rule** (canonical statement in `server/provider-policy.ts`). All four tiers green, twice. → PLAN-ARCHIVE.md.

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
  entity-name swap. Small chore owed: swap the contact page's temporary
  personal phone for Google Voice once its ID check clears. Full build
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

- [x] **Step K.7 — SECURITY.md + vulnerability-disclosure contact (both repos)** — done 2026-07-16; SECURITY.md in both repos (7-day acknowledgment, no bounty, latest-release support, each pointing at its repo's real attack surface), and `security@` + `support@mirafold.com` live via Cloudflare Email Routing → verified inbox, end-to-end tested (leftover Namecheap MX removed; Gmail never-spam filters set). → PLAN-ARCHIVE.md.

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
    1. **Phone viewport styling + small UX issues** — first real phone
       session (wifi, via app.mirafold.com): "don't love the styling yet
       and some other little things." Expected: the phone viewport has had
       near-zero mobile-specific design attention. Punch list owed.
    2. **Desktop styling issues too** — "from the session to the
       fleetview": the session view AND FleetView both have styling
       problems in Kyle's eyes. Details owed; enumerate screen by screen
       with him.
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

- [ ] **Step R.5 — Entitlement + billing** *(needs Kyle: Stripe account +
  price confirmation — BUSINESS.md §7 says $12/mo · $99/yr, held over
  $10/$79.99 on 2026-07-11)*
  - Goal: paying unlocks the relay, on launch day, with almost nothing
    standing between "want" and "paid."
  - **Phase K reshapes this step (2026-07-15; K.4 investigation done same
    day):** K.2 (the entity) is a hard prerequisite for any live payment
    configuration, and the billing vendor is now a **merchant of record —
    Paddle recommended** (K.4's verified checklist; Kyle confirms at account
    creation). The Ed25519 entitlement-token design and the relay-side check
    are vendor-agnostic and stand as built — Paddle's subscription statuses
    (`trialing`/`active`) map verbatim onto the "admit when trialing OR
    active" rule. Read the Stripe-specific text below through that mapping
    (Stripe Checkout → Paddle hosted checkout/overlay; `trial_period_days=7`
    → Paddle card-required free trial; `cancel_at_period_end` → Paddle
    scheduled cancel; Stripe webhook → Paddle signed subscription webhooks
    feeding the same minting backend). Tax, FTC negative-option mechanics,
    and EU withdrawal disclosures ride with the MoR. Sequencing: K.2 →
    K.5's ToS/privacy pages live (Paddle site verification needs them) →
    Paddle account (sandbox first) → build here.
  - Build: Stripe Checkout → a relay entitlement token; the relay admits
    daemon pairings only with an active entitlement (the *relay* checks
    entitlement — the daemon and wire protocol stay payment-ignorant);
    graceful expiry/renewal. **Trial & cancellation (settled 2026-07-11,
    BUSINESS §7):** card-required 7-day free trial via Stripe
    `trial_period_days = 7` (card captured, not charged), on both the monthly
    and annual price — the entitlement check admits pairings when the
    subscription status is `trialing` OR `active`. Cancel-anytime with **no
    refund**: set `cancel_at_period_end = true` so access holds through the
    already-paid period then lapses (no proration). **No 30-day money-back
    guarantee** — deliberately rejected (the trial covers try-before-buy;
    a guarantee would re-add refund fees + a `charge.refunded`-revoke path).
    A minimal landing page (demo GIF, install
    command, buy button, docs links) on the R.2 domain. Also (2026-07-08
    operability review): a stranger-facing top section on README.md itself —
    install, GIF, what it is, then "engineering docs below" — because the
    npm package page renders the README, and today it opens as a 60 KB
    maintainer doc. And (2026-07-08 competitive scan): before creating the
    Stripe products, a price/packaging sanity pass against the observed
    anchors — Happy $0 (free E2E relay, native apps, 22.5k stars),
    CloudCLI Cloud €7/mo, Omnara $9/mo — the tier is sold as **the genUI
    experience from any device** (uncontested), never as bare phone access
    (zero-priced by the market); $12 stands per BUSINESS §7 + the §2 first
    target unless Kyle recuts it here, eyes open.
  - **Relay `Origin` allowlist (from the 2026-07-08 security audit,
    finding #2 — deferred to here because it needs this step's domain).**
    The relay accepts viewport WebSocket upgrades from any web origin (the
    browser same-origin rule does not cover WebSockets unless the server
    checks the `Origin` header). Harmless today — a stray page can't finish
    the E2E handshake without the pairing code, so it gets nothing — but
    once this step stands up the static app-serving origin, pin the viewport
    endpoint to admit only that origin (env-configured, empty = allow any,
    same refuse-with-a-clean-close shape as the other caps). Closes the last
    "any stranger can open a socket" gap and shrinks the DoS surface the
    per-IP cap (R.2) already blunts. One Tier-2 test: right origin admitted,
    wrong origin refused, unset = allow-any preserved.
    **CODE DONE 2026-07-12** (pulled forward — it needs no Stripe, and the
    mechanism is env-configured so it lands safely before the value exists):
    `RELAY_ALLOWED_ORIGINS` (comma-separated) gates viewport upgrades; unset =
    allow any (today's behavior, preserved); a wrong origin OR a missing
    `Origin` is refused with a clean close (`CLOSE_FORBIDDEN_ORIGIN` = 4006);
    daemon dial-ins carry no `Origin` and are never gated. In `relay.ts` +
    `contract.ts` + `main.ts` (synced both repos, `sync:check` green), README
    env table + prose, and the standalone Tier-2 test (admit/refuse/missing/
    unset + daemon-unaffected). Cross-repo itest (9, real daemon) still green.
    **Still owed at deploy:** set `RELAY_ALLOWED_ORIGINS=https://<static app
    origin>` on Fly once R.5's static origin domain is final — until then it
    ships unset (allow-any), which is correct pre-launch.
  - **Relay entitlement gate — CODE DONE 2026-07-12** (the decision-independent
    half, buildable with no Stripe: every R.5 billing design ends in "the relay
    admits a pairing only with an active entitlement," so the relay's *check* is
    invariant). `RELAY_ENTITLEMENT_PUBLIC_KEY` (Ed25519 public key, base64 SPKI
    DER) gates daemon dial-ins: with it set, a daemon must present a valid,
    unexpired token on the `mirafold-entitlement` header or be refused with a
    clean close (`CLOSE_UNENTITLED` = 4007); the relay verifies signature + `exp`
    OFFLINE via `node:crypto` (no new dep, no Stripe call, no state — stays a
    dumb E2E-blind forwarder) and holds only the PUBLIC half, so it can never
    mint one. Token is compact `<b64url(payload)>.<b64url(sig)>`. Unset = no
    check (today's behavior). In `relay.ts` + `contract.ts` + `main.ts` (synced
    both repos, `sync:check` green), README, and a standalone test (valid admits
    + its viewport works / no-token / expired / garbage / wrong-key all refused);
    cross-repo itest (9, real daemon) still green.
    **Still owed (needs Kyle; vendor now Paddle per K.4):** (1) the Paddle
    **sandbox account + API/webhook credentials** (sandbox needs no site
    verification — start any time; the LIVE account needs the K.2 entity and
    K.5's pages for Paddle's site review) to build the checkout + minting
    half; (2) the **decision — where the minting backend lives**
    (recommended: a Cloudflare Pages Function on mirafold.com — $0, no new
    infra — which on Paddle's `subscription.trialing`/`.activated`/
    `.canceled` webhooks mints/expires the signed token; alt: a small Fly
    service). (3) Then: the daemon side (dial-out sends the header;
    genui-shell app code — hold until the other session frees it), and the
    R.5 open refinements (token→account binding vs. sharing,
    revocation-before-expiry window, and — 2026-07-12 audit, B2 — a
    relay-side **max token lifetime** backstop that rejects an implausibly
    long-lived `exp` even from a buggy or compromised minter). Pricing
    $12/$99 · 7-day card-required trial · cancel-at-period-end stands per
    BUSINESS §7 unless recut — all three verified native in Paddle (K.4).
    **Launch blocker (2026-07-12 audit, B2):** flipping the relay ON for everyone
    (baking the default `MIRAFOLD_RELAY_URL`, see R.2) must land **with**
    `RELAY_ENTITLEMENT_PUBLIC_KEY` set — never before. An open relay with the gate
    off lets anyone squat the pair/connection caps and lock real daemons out, so
    "entitlement gate ON at deploy" is an explicit gate on R.7, not just an owed item.
  - Done when: a sandbox-mode purchase (Paddle test checkout, per K.4)
    unlocks pairing end-to-end, and expiry re-locks it without breaking the
    local product in any way.

- [ ] **Step R.5b — Release strategy, locked (all three repos)** *(a
  decision to make + write down, not a build; do before R.6's final week)*
  - Goal: one agreed, written release sequence so R.6/R.7 execute a plan
    instead of improvising how each piece ships.
  - Decide and record: (a) **shape of the release** — private beta / staged
    rollout vs. the single M1+M2+M3 public splash R.7 currently assumes;
    (b) **per-repo mechanics + order** — `genui-shell` (repo public + `npm
    publish` + versioning/cadence), `genui-relay` (deploy pipeline, **when
    the repo flips public — owed to K.1, which relicensed it MIT**, when the
    entitlement gate flips ON, when the default `MIRAFOLD_RELAY_URL` bake
    lands — see R.2), `mirafold-site` (checkout button flip, demo swap); (c)
    **rollback / kill-switch** for each (the relay gate and per-daemon relay
    URL are the levers); (d) how the codebase/npm/GitHub rename (R.2) is
    sequenced into all of the above; (e) *already decided 2026-07-15
    (K.9): contributor policy is **DCO**, not CLA* — `Signed-off-by` per
    commit, CONTRIBUTING.md landed in both repos that day; what remains
    for this step is only the mechanics: enable the GitHub DCO status
    check on both repos as part of the public flip.
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

- [ ] **Step R.6 — Launch prep (the week before; everything verifiable
  without publishing)** *(split out of the old launch-day mega-step
  2026-07-08 — same items, grouped so nothing hides mid-paragraph; nothing
  here requires `npm publish`, most of it requires R.2's deploy)*
  - Goal: on launch morning, R.7 is a three-move sequence, not a scramble.
  - **Gemini CLI succession check (from K.3's re-verification, 2026-07-15):**
    Google stopped serving Gemini CLI requests for individual accounts on
    2026-06-18 and announced **Antigravity CLI** as the successor terminal
    agent (API-key/enterprise users continue on the legacy CLI for now).
    Verify our `gemini-cli` adapter still drives a real turn with an API key
    on current bits, and write down the Antigravity question (new adapter?
    rename? drop?) as a post-launch decision — the faithful-skin seam means
    it's one adapter either way, not a rewrite.
  - **Assets & copy** (2026-07-08 competitive scan):
    - Refresh the demo GIF with the phone beat (the §6 launch asset as
      originally imagined) — the phone beat must show a RENDERED COMPONENT
      on the phone (live checklist, chart, pinned widget), not a chat
      transcript on a phone, which is Happy/Omnara/CloudCLI's already-free
      table stakes.
    - Launch copy leads with "your terminal agent with a real UI —
      faithfully, whichever agent you run"; phone second.
    - Pre-write the honest comparison (vs Happy, CloudCLI, Omnara, Claude
      Code on the web / Codex cloud — they're good, here's the different
      bet) as a README/site FAQ section: the Show HN thread will ask "how
      is this different from Happy" in the first hour and the answer
      should be ours, not the thread's.
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
  - **SECURITY.md: name the `!`-output → model path (2026-07-17 audit):**
    before the repo goes public, add one short note: a finished `!`
    command's transcript is fed to the agent as its own turn (terminal
    parity), so untrusted text a command fetches (e.g. a curl'd page) can
    try to steer the agent — the permission prompts are the backstop, and
    the fence escaping in `server/sessions/connection.ts` keeps output from
    faking its way out of its transcript block. Public-repo readers should
    find this stated, not discover it.
  - Build, same day, in order: repo public → `npm publish` over the 0.0.1
    placeholder → verify `npx mirafold` against the real registry (the
    one check that's unverifiable until publish) → post (X + Show HN +
    r/ClaudeAI + r/LocalLLaMA with the "BYOK or fully local" line) with
    Pro purchasable from minute one.
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
- [x] **V.4 — In-session ergonomics: a "new" button, prompt focus, terminal scrollback** — done 2026-07-20 (Kyle-directed, same day). A `new` button beside home opens the startup screen in a fresh tab (`/?new=1` lands on the picker); `end` moved to the far right past the theme pill. The caret starts in the prompt box on entering any session and is re-taken when a turn ends having dropped focus to the body — never from an open overlay or over a live selection. Transcript scrolling became **conditional**, terminal-scrollback style: streamed output scrolls you down only while you're already at the bottom; scroll up and the view holds.
  - **Follow-up, the only thing still open:** the phone half of the scroll work is unverified by hand. Follow-the-tail detaches on a finger drag downward with **no minimum distance**, so a tap whose thumb wobbles a pixel downward (expanding a tool block, a pin button, a question option) silently stops auto-scrolling, and the agent then looks stalled mid-response with nothing on screen explaining why. Kyle's call 2026-07-20 was to ship it and find out by hand rather than pre-emptively guard it. If it bites: require ~8px of travel before a drag counts as steering, in `onTouchMove` (`web/src/use-follow-tail.ts`) — a real swipe is hundreds of px, thumb noise is 1–2. The touch handlers are also **not proven necessary at all**: touch held correctly without them (a finger drag isn't suppressed by a programmatic scroll the way the wheel was), and they are kept only as a guard for iOS Safari, which cannot be tested on this machine.
  - Note for anyone touching `use-follow-tail.ts`: following scrolls **instantly, never smoothly**, and the reader's **input** is what detaches, not a position delta. Both were bought with a bug — a permanently in-flight smooth animation owned `scrollTop` and made the wheel inert during streaming. The trace and the evidence are in commit `00288c6`; re-read it before reintroducing either.

- [x] **V.5 — The one-click picker row names its backing** — done 2026-07-20 (Kyle-directed, same day). Choosing Gemini started a session without ever saying an API key was what it ran on: Gemini's only backing is a key, so `needsSecondStep()` correctly skipped the backend menu — which is the one place the credential was ever named — and `agentDetail()` had nothing to fall back on (it returned the model override, and there was none). The fix keeps the one-click path exactly as it was and states the decision instead: `AgentInfo` gained an additive optional `kind` (set only when `live`), and the row renders `backingLine()` — "Gemini API key", or "Claude API key · claude-sonnet-5" when a model override exists. The wire carries the *kind* as a fact and the client owns the wording (`agents-meta.ts`), so the one-click row and the second step say the same words about the same backing. **The principle**, worth keeping: a single usable backend isn't "no choice to show," it's *a choice made on the user's behalf* — a menu you don't need can be skipped, but a decision made for the user must still be stated.
  - **Credential labels now match each vendor's own name for what you buy** (same day, Kyle's call): "Google API key" → **"Gemini API key"** (Google sells the Gemini Developer API; "Google API key" is the generic Cloud term, and we only ever said it because `GOOGLE_API_KEY` is an accepted env var — that one is the Vertex path, a different product), and "Anthropic API key" → **"Claude API key"** (the API was rebranded from Anthropic API to Claude API). "OpenAI API key" was already right. The resulting asymmetry — "ChatGPT subscription" beside "OpenAI API key" — is deliberate and documented at `backendLabel`: OpenAI keeps its consumer and API brands apart, and matching what *they* call things means inheriting that, not smoothing it.
  - Considered and **rejected** for now: making the backend menu reachable from a one-click row (a second click target on the row opening the full menu, so "why is there only one option?" has an answer). It costs a real restructure — the row is a single `<button>`, and a nested button is invalid HTML, so it becomes a div with two siblings plus a hand-written focus/keyboard story — to answer a question the row's own label mostly pre-empts. Revisit only if a real user asks it.

## Phase A — Accessibility (opened 2026-07-20; Kyle-directed, pre-launch)

Kyle's directive, verbatim: *"i want mirafold to be friendly to all people
capable of using it and to be ada compliant."* The ADA itself specifies no
technical standard for software, so the operative target — the one the DOJ
and effectively every settlement agreement point to — is **WCAG 2.1 Level
AA**. That is this phase's bar.

Starting position, from a 2026-07-20 read of `web/src/`:

- **Contrast (1.4.3 / 1.4.11) is already the strongest thing here** — V.1's
  terminal-grade floors (strong ≥12 · fg ≥11 · body ≥10.5 · mid ≥8.5 ·
  dim ≥7 · dimmer ≥5.5 · faint ≥4.5 · accents ≥4.5) clear AA's 4.5:1 by
  roughly double at the *faintest* tier, on all seven themes, enforced by a
  Tier-1 guard. Nothing owed. Do not re-open it.
- Also already present: `prefers-reduced-motion` (2.3.3) at
  `web/src/styles.css:2041`, a global `:focus-visible` rule (2.4.7) at
  `styles.css:2027`, `lang="en"` (3.1.1) in `web/index.html`.
- The gap is **programmatic semantics**: the whole app carries 4
  `aria-hidden`, 3 `role=`, 3 `aria-label`, 2 `aria-pressed` — and zero
  `aria-live`.

Primary users served: screen-reader users (Orca / NVDA / JAWS / VoiceOver)
and keyboard-only users (motor impairment — tremor, RSI, paralysis, limb
difference). Sequence A.1 → A.2 → A.3; A.4 is written last, after the others,
because it is a public conformance claim and must describe the real state.

The automated regression guard for all of this is **Step C.2**, deliberately
placed in the CI/CD phase below.

**⚑ KYLE'S HANDS — the screen-reader walk.** One item in this phase cannot be
done by the assistant at all: actually *listening* to Mirafold with a screen
reader. Everything else here is verifiable from code, the accessibility tree,
or an axe run; whether the result is comprehensible to a human ear is not.
When A.1–A.3 are code-complete, Kyle runs **Orca** (GNOME's screen reader,
`Super+Alt+S` toggles it on this Linux box) and walks: onboarding → a full
prompt→response turn → a tool call → a permission prompt → the settings card
→ connect-a-device → fleet view. What to listen for: does the response
actually get read once and whole; does anything read twice, flood, or cut
itself off; is any control announced as just "button" with no name; does
focus ever land somewhere invisible. Findings come back here as new steps.
A.1 and A.3 stay unchecked until this walk happens — their "done when"
clauses are written in terms of it deliberately.

- [ ] **Step A.1 — Live regions: streaming agent output is announced**
  - Goal: the fatal gap. A screen-reader user sends a prompt and hears
    *nothing back* — text that appears without focus moving to it is never
    announced. WCAG 4.1.3 (Status Messages). This one step is worth more
    than the rest of the phase combined.
  - Build: the design decision first — **announcement granularity**.
    Token-by-token `aria-live="polite"` on the transcript is unusable
    (a screen reader restarts or floods on every mutation); the shape that
    works is announcing at semantic boundaries — turn start, each completed
    assistant message/tool block, turn end — with the streaming text itself
    in a non-live container the user reads on demand by navigating to it.
    Then: a polite live region for turn/tool status, an assertive one
    reserved for errors and permission prompts (shell-owned, so the
    trusted-shell boundary is unaffected), and `role="log"` on the
    transcript. Status-bar state changes (busy, connection, agent) announce
    politely. Verify with a real screen reader, not by inspection.
  - Files: `web/src/components/RenderZone.tsx`,
    `web/src/components/Shell.tsx`, `web/src/components/StatusBar.tsx`,
    `web/src/components/ToolBlock.tsx`.
  - Done when: with a screen reader running, a full prompt→response turn is
    comprehensible start to finish without sighted assistance — turn start,
    tool activity, and completion each announce once, and no announcement
    floods or interrupts mid-sentence.
  - Status 2026-07-20: **code landed, box stays open on the screen-reader
    pass.** New `web/src/components/Announcer.tsx` — two visually-hidden
    regions (polite `role="status"`, assertive `role="alert"`) plus a
    two-slot alternation so a repeated message still counts as a DOM change
    and re-announces. Granularity as designed: the transcript is
    `role="log"` + **`aria-live="off"`** (log's implicit "polite" would
    re-read on every token), and Shell announces at boundaries off frames it
    already subscribes to — `user_prompt` → "Sent. Working…", `tool_use` →
    "Running {name}." (name only, never the arguments), `turn_end` → the
    turn's prose banked from `text_delta`, capped by `turnResponse()` at
    4000 chars with a pointer to the transcript, falling back to "Turn
    complete." for a tool-only turn. Assertive: `permission_request`,
    `error`, `refused`, and a real disconnect transition (guarded so the
    mount-time `connected=true` doesn't announce "Reconnected"). StatusBar's
    dot is now `aria-hidden` (a coloured circle reads as nothing) with its
    state moved onto the toggle buttons' `aria-label`. `.sr-only` added to
    styles.css using `clip-path`, NOT `display:none` — the latter drops the
    element from the accessibility tree and would silence the regions. +4
    Tier-1 on `turnResponse` (**290 green**, typecheck clean). Tier 3 NOT
    run: `server/testing/app.e2e.ts` had another session's uncommitted
    edits, and `test:e2e` rebuilds shared `dist/`. Owed before checking the
    box: the Orca walk, and a Tier-3 assertion that the regions exist and
    the transcript is `aria-live="off"`.
  - Status update 2026-07-20 (later session): **the Tier-3 half is paid.**
    The blocking uncommitted work landed (`2274d23`), so `test:e2e` could
    run: new assertion test in `server/testing/app.e2e.ts` — both announcer
    regions present (one polite `role="status"`, one assertive
    `role="alert"`), the polite region actually *spoke* the finished mock
    turn (polls for the turn's closing prose in its text — announcement
    trails the transcript paint, hence the poll, not a snapshot), and the
    transcript is `role="log"` + `aria-live="off"`. Full suite **33 e2e
    green**; Tier-1 **300 green**. The box now waits on exactly one thing:
    the Orca walk (⚑ KYLE'S HANDS above).
  - Status update 2026-07-20 (Orca walk, first slice): a real prompt→response
    turn was watched live with Orca — "Sent. Working…" announced once at
    send, the finished reply spoken once and whole (no per-token flooding).
    That's the fatal-gap case this step exists for, confirmed working. Not
    yet watched: a tool-call announcement, a permission prompt, or an error —
    box stays open until those are seen too (see A.3's status update for the
    rest of tonight's walk and why the box isn't closing yet).
  - Status update 2026-07-21: the tool-call and permission-prompt case is now
    covered a different way than planned. Kyle's live walk of it went wrong
    twice in the same sitting — once because the dev server still had a real
    `ANTHROPIC_API_KEY` in `.env`, so the deterministic mock trigger
    ("dangerous") silently no-opped against the live agent instead of firing
    the canned permission prompt; and once because this same Claude Code CLI
    terminal's animated title was flooding Orca's AT-SPI event queue while
    background tool calls ran, degrading the audio into something
    unintelligible. Kyle, reasonably, declined to retrigger the scenario
    again in any form — the first mixup meant he'd approved a real
    `rm -rf /var/cache/app && systemctl restart app` believing it was fake.
    (It was fake; the mock never shells out. But the trust cost of that
    mixup is the point.) In place of the live listen: a new Tier-3 test
    (`server/testing/app.e2e.ts`, "A.1: tool_use and permission_request
    announce") drives the exact same flow headlessly against the
    itest-harness daemon (credentials always forced empty — no real key can
    reach it) and asserts the assertive region's actual text —
    `"Permission needed: Bash. rm -rf /var/cache/app && systemctl restart
    app"` — plus the polite `"Running Bash."` on allow and the turn's
    conclusion text, then that the bar clears. **35/35 e2e green,
    typecheck clean.** This proves the announcement wiring is mechanically
    correct; it does not prove Orca's TTS renders it comprehensibly, which
    still needs a human ear — but for this specific case, headless proof is
    the standing substitute going forward, not another live trigger.
    Settings/theme card and the fleet session list's keyboard behavior WERE
    confirmed live later the same session — see A.3's 2026-07-21 status
    notes below. The one piece of A.1 still genuinely open: an actual error
    announcement (attempted the same night via the `!` bang-concurrency
    error, but drowned out by the same terminal-noise problem — see A.3's
    closing note).

- [x] **Step A.2 — Every control is a real control** — done 2026-07-20
  (third file closed by A.2b below, same day)
  - Goal: six `onClick` handlers sit on `div`/`span` elements — unreachable
    by Tab, unannounced as controls. WCAG 2.1.1 (Keyboard) and 4.1.2 (Name,
    Role, Value).
  - Build: convert each to a real `<button>` (or give it `role` + `tabIndex`
    + key handling where the styling genuinely can't survive the swap —
    prefer the swap). Audit accessible *names* while in each file: an
    icon-only control needs an `aria-label` that says what it does, and
    decorative glyphs need `aria-hidden="true"` so they aren't read aloud.
    Theme pill markup is LOCKED — semantics/labels only, no visual or
    behavioral change.
  - Files: `web/src/components/ConnectDevice.tsx`,
    `web/src/components/Onboarding.tsx`,
    `web/src/components/ThemePicker.tsx`.
  - Done when: every interactive element in those three files is reachable
    and operable by Tab + Enter/Space, announces a meaningful name and role,
    and nothing about the rendered appearance changed.
  - Status 2026-07-20: **two of three files done** (`ThemePicker.tsx`,
    `ConnectDevice.tsx`); `Onboarding.tsx` deferred — another session had it
    open with ~183 uncommitted lines. **The step's framing was wrong and is
    corrected here:** the six `div`/`span` `onClick` handlers are NOT
    disguised buttons. Four are the backdrop-click-to-dismiss + card
    `stopPropagation` pair in the two overlays, and one more of each in
    Onboarding. A backdrop already has keyboard equivalents (Escape via
    `useEscapeKey`, plus an explicit ✕), so 2.1.1 is satisfied and promoting
    it to a control would park a page-sized meaningless stop in the tab
    order — left as plain divs, each with a comment saying why. The real gap
    in those files was **dialog semantics and names**: neither overlay had
    `role="dialog"`, `aria-modal`, or an accessible name, so a screen-reader
    user got no signal a modal had opened. Both cards now carry all three
    (`aria-labelledby` → the existing title span). Also: `❯` glyphs and the
    slotted-row `✓` marked `aria-hidden` (decorative), both ✕ buttons given
    real `aria-label`s instead of relying on `title` alone, theme groups
    wrapped in `role="group"` + `aria-label`, and each theme row given
    `aria-pressed` — the `✓` was previously the *only* thing marking the
    slotted row. Visual output unchanged; the LOCKED status-bar pill was not
    touched. Typecheck clean, Tier-1 **290 green**.

- [x] **Step A.2b — Onboarding's share of A.2** — done 2026-07-20
  - Goal: the same treatment for `Onboarding.tsx` — dialog/step semantics,
    accessible names on icon-only controls, decorative glyphs hidden, and
    its two backdrop/stopPropagation divs commented like the others.
  - Was blocked on another session's in-flight onboarding work; that landed
    as `2274d23` and this went in the same day. The card now carries
    `role="dialog"` + `aria-modal` + `aria-labelledby` → the existing
    `<h1>` (which already renames itself per step — "pick its backing" /
    "pick a model" — so the dialog's accessible name tracks the step for
    free). The logo `<img>` is decorative beside that heading and went
    `alt=""` + `aria-hidden` (the brand is still spoken — the subtitle
    says "Mirafold re-skins…"); the two `←` back-button glyphs are
    `aria-hidden` spans so a reader says "all backends", not "leftwards
    arrow all backends". Backdrop div commented with the ThemePicker
    rationale (Escape already walks the steps back). No other unnamed
    controls existed — every row was already a real `<button>`. Onboarding's
    focus trap went in under A.3 the same sitting. Visual output unchanged.
    Typecheck clean, Tier-1 300 green, Tier-3 33 green.

- [ ] **Step A.3 — Focus management + the manual keyboard pass**
  - Goal: Escape is already handled uniformly — `useEscapeKey`
    (`web/src/use-escape.ts`) is used by all three overlays
    (`ThemePicker.tsx:45`, `ConnectDevice.tsx:52`, `Onboarding.tsx:217`), so
    2.1.2 (No Keyboard Trap) is likely already satisfied. What is missing is
    *focus*: an opening overlay leaves focus behind it, Tab then walks the
    page underneath, and closing loses focus entirely. The app's only
    `.focus()` call is the prompt autofocus at `Shell.tsx:396`. WCAG 2.4.3
    (Focus Order).
  - Build: one `useFocusTrap` hook mirroring `useEscapeKey`'s shape — on
    open, record `document.activeElement` and move focus into the container;
    cycle Tab within it; on close, restore focus to the opener. Apply to the
    same three overlays. Assess `FleetView.tsx:145` (it already has its own
    `onKeyDown`) for whether the session list should become a roving-tabindex
    widget, and give `PinDock.tsx` (66 lines) the same look. Then the part no
    grep substitutes for: **a manual pass through the whole app** with
    keyboard only, then again with a real screen reader (Orca locally;
    VoiceOver if a Mac is available) — onboarding, a full session, the
    picker, connect-device, fleet view.
  - Files: new `web/src/use-focus-trap.ts`;
    `web/src/components/{ThemePicker,ConnectDevice,Onboarding,FleetView,PinDock}.tsx`.
  - Done when: every overlay takes focus on open and returns it on close, the
    entire app is operable mouse-free end to end, and the manual
    screen-reader walk is recorded here with what it found.
  - Status 2026-07-20: **hook built and wired to the two free overlays.**
    New `web/src/use-focus-trap.ts` — `useFocusTrap(ref, active)`, the same
    shape as `useEscapeKey` (inactive ⇒ no listener) and deliberately
    separate from it so an overlay can take one without the other. Does the
    three things the browser won't: focus in on open, Tab cycles inside,
    focus restored to the opener on close. One non-obvious bit worth keeping:
    visibility is tested with `getClientRects().length`, not `offsetParent`,
    which is null for `position: fixed` — and these cards are fixed, so the
    usual check would have matched nothing. Listener is capture-phase so the
    trap wins before anything inside reacts to Tab. Wired into
    `ThemePicker` (always active — mounted only while open) and
    `ConnectDevice` (tracks `open`; returns focus to the ⧉ pair button).
    `PinDock` had no trap to add (not a modal) but did have unnamed
    controls: the `<aside>` landmark is now labelled and both icon-only
    buttons carry `aria-label`. Typecheck clean, Tier-1 **291 green**.
    Still owed: `Onboarding.tsx` (see A.2b — same blocker), the FleetView
    decision below, and the Orca walk.
  - Status update 2026-07-20 (later session): **Onboarding wired** — the
    third overlay took the trap once `2274d23` landed (always-active, same
    as ThemePicker: Shell mounts it only while shown). All three overlays
    now trap. Remaining before the box closes: the A.3b FleetView decision
    (below), and the Orca walk.
  - Status update 2026-07-20 (Orca walk, first slice — laptop died mid-walk
    last session, resumed here): walked onboarding and a chat turn with Orca
    for real, after fixing an environment gap first — GNOME's
    `screen-reader-enabled` gsettings key was off (launching the bare `orca`
    binary, unlike the Settings toggle, doesn't set it), so Chrome's
    accessibility bridge never activated; nothing was reachable until that
    was flipped. **Real bug found and fixed:** `useFocusTrap` correctly traps
    Tab, but nothing hid the rest of the page from the accessibility tree, so
    Orca's Browse-mode cursor (not just Tab) could still read straight into
    the session sidebar behind the "Choose your agent" dialog — confirmed by
    landing on `genui-shell visited link` / `Rename session` mid-walk with
    the dialog still open. `aria-modal="true"` alone doesn't stop this on
    Chrome+Orca; the APG's documented fallback is hiding siblings from the
    tree outright. Fix: new `.behind-dialog { display: contents }` in
    `styles.css` (transparent to flex/grid layout) wraps everything except
    the dialog in both mount points (`FleetView.tsx`, `Shell.tsx`) with
    `inert={<dialog open>}`. Verified three ways: `yarn typecheck` clean;
    DOM-level (`.focus()` called directly on a background button while the
    dialog was open did not move focus); and a second live Orca pass — Tab
    now cycles only the dialog's own four elements and wraps, zero sidebar
    leakage. Tier-1 **300 green**, Tier-3 **34 green**. One earlier finding
    from this same walk ("streaming status text updates too fast to be
    usable") was investigated and retracted — it was Claude Code CLI's own
    terminal status animation bleeding into the same Orca debug log, not
    anything Mirafold renders; grepped the whole repo to confirm no such
    title/live-region logic exists.
  - **Box stays open.** KYLE'S HANDS above lists the full walk: onboarding →
    a full turn → a tool call → a permission prompt → settings → connect-a-
    device → fleet view. Tonight only covered the first two and the
    onboarding dialog's focus containment. Still unwalked: a tool call, a
    permission prompt, the settings/theme card, connect-device, and the
    fleet session list/sidebar's own keyboard behavior (ironically the same
    surface the dialog was just leaking focus into). Pick up there next
    session.
  - Status update 2026-07-21: **settings/theme card and fleet session list
    both confirmed live, cleanly, with real audio** (Orca restarted mid-
    session with `--debug-file` after discovering Chrome's own
    `chrome://accessibility` showed "Screen reader: disabled" for the tab —
    Chrome had cached "no AT present" from before Orca registered on the
    AT-SPI bus, and only a full Chrome relaunch, not a page reload, forced
    it to re-detect; noted for next time). Theme card: "settings dialog" on
    open, "theme panel." / "Light themes panel." / "Dark themes panel." as
    group labels, "Light theme." / "Dark theme." per row — clean, single-
    utterance, no repeats. Fleet session list: Tab reaches "Rename session
    {name} push button." and "End session {name} push button." distinctly
    (the A.3b fix — each button's name, not just "end"/✎ alone) — confirmed
    twice across two separate walks. Tool call + permission prompt did NOT
    get a clean live confirmation — see A.1's 2026-07-21 status note for
    what happened there and why a headless Tier-3 test stands in for it
    going forward instead of a repeat live trigger.
  - Closing status, 2026-07-21 (end of session): **two items remain
    genuinely open, both needing a live walk, neither attempted
    successfully tonight.**
    - **An actual error announcement.** Attempted via the `!` passthrough's
      concurrency guard (`!sleep 5` then a second bang command before it
      finishes → "a ! command is already running (stop it first)", a real
      `type: "error"` broadcast — see `server/sessions/connection.ts:427`,
      adapter-agnostic, no scary content, safe to repeat). Never got a
      clean listen: by the time it was tried, Orca's speech had been
      silently toggled off for ~18 minutes (found by grepping the debug
      log — "Speech disabled." at 05:40:39 — nobody had noticed), and after
      restarting Orca to fix that, the terminal-title-flooding problem
      (this session's own recurring finding, see below) was still bad
      enough that all that came through was the terminal repeating its own
      status text.
    - **Connect-device.** The relay stub (`server/relay/relay-stub.ts`) is
      wired into a dev session via `MIRAFOLD_RELAY_URL=ws://127.0.0.1:9100`,
      so the `⧉ pair` button exists to walk. It IS verified correct at the
      DOM/axe level — dialog semantics, focus trap, and a real bug (the
      pairing-URL scroll box wasn't keyboard-focusable) found and fixed via
      the axe-core sweep below — but the live audio walk itself never
      happened; the session went into the contrast-token work instead.
    - **Root cause behind both misses, worth fixing before trying again**:
      this Claude Code CLI terminal's own title animates continuously
      (spinner + elapsed time), even seemingly while idle, and each change
      fires an AT-SPI event Orca has to process — badly degrading its
      speech for whatever else has real focus (Chrome, here). Checked for a
      Claude Code setting to suppress it: none exists. The one documented
      workaround is running the CLI inside `tmux` with
      `set -g allow-passthrough off`, which blocks the title-setting escape
      sequences from ever reaching the terminal — untried this session
      (means restarting the terminal session, Kyle's call on when). Kyle's
      2026-07-21 call on the wasted time chasing this: stop fighting the
      environment, lean on headless/DOM verification for anything
      mechanically checkable (done — see the axe-core sweep below), and
      save actual ears for one clean pass with the CLI fully closed, not
      just idle, whenever that's convenient — not urgent, since no real
      user will ever have this terminal open.

- [x] **Step A.3b — FleetView rows: nested interactive controls** — done
  2026-07-20 (resolved by Kyle's standing rule, same day)
  - Finding (2026-07-20): the plan guessed FleetView needed a roving
    tabindex. It doesn't — `FleetView.tsx:145` is just the rename input's
    Enter/Escape handling, which is fine. The real problem is structural:
    each session row is an `<a href="/s/…">` with **two `<button>`s nested
    inside it** (`fleet-edit` ✎ at :153, `fleet-end` at :174). Interactive
    content inside an anchor is invalid HTML, handled inconsistently across
    screen readers, and it makes the link's accessible name swallow the
    entire row — name, agent, model, session id, status, relative time, and
    the word "end" all read as one enormous link label.
  - This was flagged as Kyle's call because the obvious fix (name becomes
    the link) loses click-anywhere-to-open. **Kyle's answer became a
    standing rule**, verbatim: *"i'm down with EVERY standard pattern for
    accessibility we can add so long as it doesn't change the interface or
    functionality for non-disabled users, only then do i want to be
    consulted."* The **stretched-link card pattern** satisfies exactly that
    bar, so consultation dissolved: the row is now a plain `div`, the
    session *name* is the row's one `<a>` (`.fleet-link`), and its `::after`
    overlay stretches the link's hit area over the whole row — a mouse
    still opens the session from anywhere, a screen reader hears
    "*name*, link" instead of the whole row. The ✎/end buttons (and the
    rename input) ride above the overlay via `position:relative; z-index:1`,
    and both buttons gained `aria-label`s that name their session ("End
    session *name*") — the visible "end"/"✎" alone doesn't say which. The
    buttons' `preventDefault()` calls (there only to stop the old anchor
    navigating) are gone. One knowingly-accepted micro-change: mid-rename
    the name link is unmounted, so clicking row background during a rename
    commits the rename (blur) but no longer ALSO navigates — the old
    behavior was closer to a bug.
  - Files: `web/src/components/FleetView.tsx`, `web/src/styles.css`
    (overlay + z-index), `server/testing/app.e2e.ts`.
  - Verified: new Tier-3 test — row is a `div`, exactly one link per row,
    and the buttons genuinely sit above the overlay (Playwright's hit-target
    check fails the click if the overlay intercepts): "end" arms in place,
    ✎ opens the rename in place, neither navigates; click-anywhere is
    proven by the two pre-existing row-body clicks and the phone tap.
    Typecheck clean, Tier-1 **300 green**, Tier-3 **34 green**.

- [ ] **Step A.4 — Public accessibility statement** *(write LAST)*
  - Goal: a dated, public, specific conformance claim, plus a way to report
    problems. Not a WCAG requirement — a launch artifact, and the honest
    counterpart to the work above. Same precedent as K.5: the document is
    planned here, the page ships in the `mirafold-site` repo alongside
    `terms.html` / `privacy.html` / `refunds.html` (same stylesheet, no
    build step).
  - Build: the standard four parts — the standard targeted (WCAG 2.1 AA),
    the real current conformance status, known limitations stated plainly,
    and a contact path (reuse `support@mirafold.com`, live since K.7). Then
    a footer link and a `sitemap.xml` entry. **Specific and honest beats
    broad**: "conforms except X and Y" is defensible and useful; a blanket
    "fully accessible" claim contradicted by one axe run is worse than
    publishing nothing. Must not be written before A.1–A.3 land.
  - Files: `mirafold-site/public/accessibility.html`, plus that repo's
    footer partial (shared CSS already covers all pages) and `sitemap.xml`.
  - Done when: the page is live, linked from the footer of every site page,
    in the sitemap, and every claim on it is one someone could verify.

**2026-07-21 — manual axe-core sweep, run ahead of C.2.** Tonight's Orca walk
kept getting derailed by environment problems, not app bugs (see A.1/A.3's
notes above): a stray real `ANTHROPIC_API_KEY` in `.env` silently defeated the
mock's deterministic triggers, and this same Claude Code CLI terminal's own
title animation flooded Orca's AT-SPI event queue badly enough to make its
speech unintelligible, even seemingly while idle — cause not fully isolated;
no Claude Code CLI setting exists to suppress it (checked), only an
untried external `tmux allow-passthrough off` workaround. Kyle's call
(2026-07-21): stop burning time on that environment fight tonight — it's
self-inflicted and irrelevant to real users, who'll never have this terminal
open. Split the work instead: everything mechanically checkable, do headlessly
now; the genuinely human-judgment "does it sound right" pieces, save for one
clean pass with the CLI fully closed (not just idle), on Kyle's own time.
In that spirit, axe-core 4.10.2 (CDN, not installed as a dependency — a
one-off gut-check, not yet wired into Tier 3) was run by hand against the
live dev session across four states: the fleet/landing view, connect-device
open, onboarding open, and a live session transcript with a rendered
checklist. Three real, previously-unknown findings, two fixed on the spot as
standard invisible-to-sighted-users patterns (pre-approved, [[a11y-standing-
rule]] in memory):
  - **Fixed:** `.pair-url` (`ConnectDevice.tsx`) — the pairing URL's
    `overflow-x: auto` scroll box had no `tabindex`, so a keyboard user could
    never focus it to scroll and read the full URL. Added `tabIndex={0}`.
    Zero visual change.
  - **Fixed:** GFM task-list checkboxes (`- [x] thing` in any rendered
    markdown — the plan-it-step-by-step checklist, any future checklist
    render) had NO accessible name — axe flagged it `critical`. The label
    text is a sibling of the `<input>` inside the `<li>`, not a child of it,
    so the fix lives in a new shared `li` override in
    `web/src/registry/Md.tsx`'s `safeAnchor` (consumed by both `Md`/
    `MdDetail` and `RenderZone`'s turn-text rendering): pulls the checkbox
    out of the item, reads the rest of the `<li>` as its `aria-label`. Zero
    visual change — the checkboxes are already `disabled` (decorative
    reflection of markdown state, never real form controls).
  - **Fixed, Kyle signed off (2026-07-21, "minor changes like that are
    okay"):** `--warn-fg` in the **light** theme (`#737300` → `#6e6e00`) and
    `--accent` in **light** (`#008000` → `#007c00`) and **solarized-light**
    (`#677600` → `#606d00`), plus solarized-light's `--info` and `--error`
    (both ~7% darker). All were passing the Tier-1 guard's 4.5:1 floor
    against `--bg` (the only surface it checked) but fell short — as low as
    3.57:1 — against the actual card/badge surfaces they render on in
    practice (`.onb-blocked`, `.onb-agent-detail`, `.demo-banner-badge`).
    Separately, `.onb-agent-detail`'s deliberate `opacity: 0.85` dim
    (`styles.css`, "reads as confirmation, not a warning") was dropped
    entirely — full-strength `--accent` lands exactly on this codebase's own
    stated accent floor (`accents ≥4.5`, this section's intro), no dimming
    needed. **The guard itself is fixed too**: `themes.test.ts`'s accent
    contrast test now checks the same `TEXT_SURFACES` list the tier-floor
    test already used, not just `--bg` — this is what surfaced all of the
    above, plus more.
  - **Also fixed, same sign-off, after a caught mistake:** the same guard
    extension caught six more real gaps — **solarized-dark's entire accent
    set** (worst case 3.9:1) and **`--error` alone in dracula/gruvbox-dark**
    (4.0–4.3:1). First pass here got the fix direction wrong: a script
    computed "darken by ~60%" for all of these without checking that dark
    themes put LIGHT text on a DARK background, so darkening further would
    have *reduced* contrast, not fixed it — caught before anything was
    applied by checking each theme's actual `--bg` value, and corrected to
    brightening (7–14%, not 60%) for all six. `dark`'s `--error` was
    misreported as failing in an earlier note here — it was never actually
    below the floor (4.94:1); no change needed there. Final values: solarized-
    dark `--accent` `#859900`→`#94a61f`, `--info` `#3496da`→`#4ea4df`,
    `--warn-fg` `#b58900`→`#be981f`, `--error` `#e56865`→`#e97d7a`; dracula
    `--error` `#ff5555`→`#ff6e6e`; gruvbox-dark `--error` `#fb5844`→`#fb6552`.
    Every fix (all 7 themes now) uses the same method: scale RGB channels by
    a uniform percentage toward white or black as appropriate, which
    preserves hue exactly — nothing shifted color family, only how far it
    sits from its background. No debt left; the temporary
    `ACCENT_SURFACE_CONTRAST_DEBT` allowlist was added then removed the same
    session once every entry was resolved.
  - Typecheck clean, Tier-1 **300 green**, Tier-3 **35 green** (includes the
    new A.1 tool_use/permission_request test from tonight, see A.1's status
    note above) after all fixes, all 7 themes.

---

## Phase C — CI/CD (opened 2026-07-20; pre-launch)

Kyle is standing up CI/CD shortly. As of 2026-07-20 there is **none** in any
of the three repos: `genui-shell/.github/` holds only an issue template, there
are no workflows and no git hooks, and neither `genui-relay` nor
`mirafold-site` has a `.github/` at all. Verification today is Kyle running
`yarn test` / `test:server` / `test:e2e` by hand — a good habit, but a habit.

Sizing note from the 2026-07-20 read: **Tier 3 is unusually CI-ready.** The
browser path is already an env override (`process.env.CHROME_BIN ??
"/usr/bin/google-chrome"`, e.g. `server/testing/app.e2e.ts:17`), Playwright
launches headless by default (no virtual display needed), and the harness
forces credentials empty → `MockSession`, so there are **no secrets to
provision, no API spend, and no live-model flakiness**. Both previously-named
flakes were root-caused and fixed 2026-07-19 (`9de5bc1` Tier-2 handshake
listener, `60b8307` Tier-3 settle); the only residual is a single
uncharacterized sighting of the Tier-2 per-pair viewport-cap test.

- [ ] **Step C.1 — Stand up CI** *(Kyle's call on scope)*
  - Goal: the test suite runs itself on every push, so nothing load-bearing
    depends on remembering.
  - Build: GitHub Actions. Decide the tier schedule — Tier 1 on every push
    is seconds; Tier 2 and Tier 3 are minutes (`test:e2e` runs `yarn build`
    first), so the normal split is those on pull requests and on the default
    branch. Node 22 + yarn; confirm whether `ubuntu-latest`'s preinstalled
    Chrome sits at the default path or `CHROME_BIN` needs setting. Turn on
    the DCO check at the same time (owed from K.9, gated on the public flip).
    **Tier 4 (`test:live`) never runs in CI, and no provider credential is
    ever added to repo secrets** (2026-07-20 audit): it drives real binaries,
    and one of its tests deliberately uses a real `OPENROUTER_API_KEY` against
    openrouter.ai. In CI that means real spend on every run, third-party
    requests attributed to the key from GitHub's runners, and — once the repo
    is public at R.7 — a secret reachable by anyone who can get a workflow to
    run. It stays a local, hand-run tier.
    CD (deploy) is a separate question — the relay's deploy path and the
    site's Cloudflare Pages build are already their own mechanisms.
  - Files: `.github/workflows/` in each repo as scoped.
  - Done when: a pushed commit gets a pass/fail mark automatically, a
    deliberately broken test turns it red, and a green run means the same
    thing a local full-suite run means.

- [ ] **Step C.2 — Automated accessibility check (axe-core) in Tier 3**
  - Goal: the regression guard for Phase A. Accessibility decays silently —
    a refactor swapping a `<button>` for a styled `<div>`, or dropping an
    `aria-label`, looks and behaves identically to a sighted mouse user and
    is a wall to a screen-reader user. The theme contrast floors are the
    proof the pattern works: they hold across two new themes and multiple
    rounds of edits because a test remembers them. Nothing else in the UI has
    that memory. Note the scope honestly: automated scanning catches roughly
    a third of WCAG issues — the machine-checkable subset. It does not
    replace A.3's manual pass.
  - Build: **Tier 3, not Tier 1.** Web unit tests render no React at all
    (`node:test` over pure functions — see `web/src/components/ToolBlock.test.ts`);
    there is no jsdom, happy-dom, or Testing Library anywhere, and the
    zero-test-deps rule says keep it that way. Tier 3 already drives real
    Chromium against the real app. So: add `axe-core` as a dependency, inject
    its source into the page, run it via `page.evaluate`, and assert zero
    violations at `serious` and `critical`. The real cost is **triage of the
    first run** — every codebase's first scan reports findings; each becomes
    a fix or a documented exception. This step does **not** depend on C.1 —
    the check is just a test, so it can (and should) land first and be
    triaged to green locally; CI then picks it up for free.
  - Files: `server/testing/app.e2e.ts`, `package.json`.
  - Done when: `yarn test:e2e` fails on an introduced accessibility
    regression (verified by deliberately breaking one), passes clean
    otherwise, and every accepted exception is written down with its reason.

---

## Phase D — Decompose the Codex adapter (opened 2026-07-20; **next up**)

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
green as of 2026-07-20.

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
  - Done when: `yarn typecheck` clean; `yarn test` still **298 pass / 0 fail**
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
