# Mirafold Live Document View — Implementation Specification

Status: approved, implemented, and verified 2026-08-19. This is the canonical
product and implementation specification for Phase LD in `PLAN.md`.

## 1. Objective

Change Mirafold's assistant-output presentation from a mostly flat stream of
Markdown plus isolated rich components into a **live, responsive document
composition**.

The key product idea is:

> An agent response should feel like a document/interface being constructed
> live in front of the user, not like terminal text with occasional paintings
> dropped between paragraphs.

This is intentionally the more opinionated direction. It should make Mirafold
visually distinctive while preserving the properties that already make it
useful as a coding-agent shell:

- immediate streaming;
- serious technical density;
- exact visible transcript order;
- rich components appearing as soon as they arrive;
- no wait for response completion;
- Explorer, file view, pin dock, prompt, status bar, tool activity,
  permissions, and other shell behavior;
- all existing themes;
- the existing registry, protocol, and security/trust boundaries.

This is a presentation and composition change downstream of the existing
transcript projection. It is not a new wire or rendering architecture.

The accurate compatibility promise is:

> No intended change to protocol, content semantics, actions, or shell
> capabilities; a substantial intentional change to presentation and layout.

## 2. Product target

Today, an ordinary response is approximately:

```text
user prompt

assistant prose

[rich component]

assistant prose

[rich component]

assistant prose
```

After this work, the same response should read as one live technical
composition:

```text
user prompt

explanation / summary

section heading
supporting prose

[diff / chart / table / status / component]

interpretation

section heading
[another component]

conclusion / next steps
```

This does not imply a literal giant bordered card. The composition should feel
unified through deliberate measure, typography, rhythm, alignment, and shared
geometry.

A one-sentence answer should remain almost effortless. A long Markdown answer
should gain hierarchy without becoming a blog template. A render-heavy answer
should become unmistakably coherent and distinctly Mirafold. Tool-heavy work
must remain dense and operational.

## 3. Product stance

### 3.1 Opinionated default; no classic-transcript toggle

The live document view is the product direction, not an optional skin.

Do not add:

- a "classic transcript" toggle;
- a per-session fallback mode;
- a preference that leaves both old and new composition systems alive;
- a second rendering path that must be maintained indefinitely.

Restraint in the default design—not retreat behind a preference—is how this
remains welcoming to serious users.

### 3.2 What this phase does and does not unlock

This phase makes existing Markdown, registry renders, and artifacts compose as
one answer. It does not cause agents to invoke registry components more often.
Agent guidance or new generative components, if later desired, are a separate
phase and must not be smuggled into this one.

The live-document compositor is necessary infrastructure for richer agent
output, but its success must also be visible for text-only answers.

## 4. Visual direction

### 4.1 Preserve the active Mirafold theme

Use the same active theme as the rest of the application.

Do not:

- introduce a white paper surface in dark mode;
- introduce a document-specific palette or theme;
- hard-code colors;
- make the response resemble a foreign webpage;
- change existing theme palettes merely to support this feature.

Structural CSS consumes existing theme variables. If a semantic alias is
genuinely needed, it must map to existing theme values rather than expand the
palette contract casually.

### 4.2 No chat bubbles

Do not turn assistant responses into conventional left/right chat bubbles.
Mirafold is a workbench, not a messaging application.

### 4.3 No giant outer card

The whole response must not become a rounded rectangle with a shadow. The
outer response boundary is a layout and identity boundary, not decorative
chrome.

### 4.4 Prose is transparent by default

Do not put a visible bordered card around every independently streamed prose
chunk. That would turn prose + component + prose into card + card + card,
increase scroll height, and reinforce the inserted-painting feeling this phase
exists to remove.

The daring treatment should come first from:

- deliberate width;
- typography and heading hierarchy;
- paragraph/list rhythm;
- alignment;
- restrained separators;
- component placement;
- coherent spacing.

If complete-screen evaluation proves that prose still needs a surface, use an
extremely quiet continuous field or inset treatment. Do not add per-chunk
border/radius/padding boxes by default. No shadow, glow, or marketing-site
chrome.

### 4.5 Dense, not airy

This remains a coding-agent interface. A normal answer must not become a long
editorial page that requires dramatically more scrolling.

Target:

> More composed than terminal output, denser than consumer chat or an article
> reader.

## 5. Current architecture and insertion point

The current stateful `createTranscriptProjection()` remains authoritative for
wire-to-view chronology and visible row semantics.

```text
wire events
    ↓
createTranscriptIngress() batching
    ↓
createTranscriptProjection()
    ↓
TranscriptSnapshot.rows (projected visible top-level rows)
    ↓
pure response-composition grouping
    ↓
RenderZone / ResponseDocument
```

Do not independently rescan raw wire messages or recreate transcript
visibility rules in `RenderZone`.

Do not:

- replace the flat transcript with nested persisted response objects;
- store display groups in React state;
- move registry components into a new protocol object;
- alter wire messages for presentation;
- move chronology, tool folding, subagent-deck construction, picker state, or
  painting identity out of the transcript projection.

The grouping layer consumes `TranscriptSnapshot.rows`, preserves their exact
objects and IDs, and derives ephemeral display items.

This keeps replay, wire order, pin identity, update-in-place paintings,
streaming, recovery, tool folding, and current server semantics unchanged.

## 6. Display vocabulary

Conceptually:

```ts
type TranscriptDisplayItem =
  | { kind: "entry"; key: number; row: OutputZoneRow }
  | {
      kind: "response-document";
      key: number;
      responseKey: number;
      continuation: boolean;
      rows: readonly DocumentRow[];
    };
```

Exact names may follow local TypeScript conventions, but the responsibilities
must remain this small.

### 6.1 Document-eligible rows

The following projected top-level rows are agent-presented answer content:

- assistant `text`;
- `render`;
- `artifact`.

Pinned stubs do not need a separate grouping type. Pin state changes the
renderer for the same eligible render/artifact row, so the stub remains in the
same document position automatically.

The current protocol `error` message is projected as assistant Markdown. This
phase preserves that existing behavior; it does not infer or introduce a new
error-row semantic.

### 6.2 Shell-owned or provider-faithful rows

These retain their current identity and renderer:

- user prompt rows;
- thinking rows;
- tool rows and settled tool folds;
- notices;
- bang commands and output;
- picker rows;
- subagent decks.

Permissions and the global activity line are shell chrome outside
`TranscriptSnapshot.rows`; the grouping helper must not duplicate or absorb
them.

Shell rows may align to the same content axis later, but must never be restyled
as model-authored Markdown or placed inside a generic prose card.

## 7. Grouping and boundaries

Visual unity and DOM grouping are not the same thing. One response may contain
multiple transparent document segments separated by shell-owned rows while
still sharing one visual rhythm.

### 7.1 Hard boundaries

A hard boundary ends the current response sequence. The next eligible row
starts a new `responseKey`.

Initial hard boundaries:

- a user prompt;
- a bang command/output block, which is a separate user-authored command
  interaction.

Any later hard-boundary addition requires a concrete transcript scenario and
a unit test. Do not grow this category casually.

### 7.2 Soft interruptions

A soft interruption remains a top-level entry and splits the document into
transparent DOM segments, but does not reset the response sequence's visual
identity.

Initial soft interruptions:

- thinking;
- tool activity and settled tool folds;
- notices;
- pickers;
- subagent decks.

Assistant content before and after a soft interruption may have different
`ResponseDocument` wrappers but the same `responseKey`; later visual work can
keep their spacing related without pretending the shell row is prose.

### 7.3 Transparent records

Nested subagent prose/tool records are already absent from the projected
top-level row sequence and therefore cannot fragment documents. Grouping must
operate on projected visible rows rather than rediscovering invisibility.

### 7.4 Exact order wins

Never reorder entries to obtain a prettier composition. Multiple segments are
acceptable when the transcript requires them.

## 8. `ResponseDocument`

Introduce a small shell-presentation component named `ResponseDocument` if it
keeps `RenderZone` focused.

It is not a registry component and must not be added to
`web/src/registry/index.ts` or `server/registry-spec.ts`.

Its responsibilities are only:

- establish a stable transparent layout boundary;
- carry document/continuation classes or data attributes;
- establish local layout rhythm;
- render existing row children in order.

It must not:

- concatenate Markdown;
- inspect model words for meaning;
- generate headings;
- change registry props;
- wait for turn completion;
- own pin, protocol, or transcript state;
- reinterpret row visibility.

## 9. Streaming requirements

Streaming is load-bearing.

- The document appears on the first assistant token.
- A render or artifact appears immediately when its projected row arrives.
- Later text opens immediately beneath it.
- Nothing waits for `turn_end`.
- Existing text/render boundaries remain authoritative.
- The full answer is never concatenated into one Markdown string.
- Old Markdown chunks are not reparsed merely because a later chunk streams.

Each prose row remains independently streamed and rendered.

## 10. Mounted identity and ancestry

Stable keys are necessary but not sufficient. React identity also depends on
ancestry.

The invariant is:

> Appending later transcript activity must not change the React ancestry or
> key of any already-mounted render or artifact row.

Use document keys derived from the first eligible row ID in that segment. Use
existing row IDs for children. Appending to a segment must preserve its wrapper
key; a later soft interruption must not retroactively move an earlier child.

Tests must cover:

- later text after a mounted render;
- an intervening shell row;
- update-in-place render IDs;
- pin and unpin transitions;
- replay;
- subagent activity represented by a deck.

A browser-held DOM node or property sentinel is an acceptable direct identity
oracle. A stateful existing component interaction is an even stronger oracle
when available.

## 11. Document and prose width

Use two deliberate measures rather than one narrow cap for everything.

Recommended starting points, to be tuned on the complete screen:

- rich document/component lane: approximately 1100–1200px maximum or the
  available center width, whichever is smaller;
- ordinary prose measure: approximately 72–78 characters.

Required outer mechanics:

```css
width: 100%;
max-width: <rich document measure>;
min-width: 0;
```

Prose can use an inner measure while diffs, diagrams, charts, consoles,
artifacts, and tables use the wider lane. Both align on one deliberate visual
axis.

Do not waste wide technical workspaces merely to enforce article width, and do
not let prose stretch into unreadably long lines.

## 12. Workbench responsiveness

Explicitly exercise:

```text
center only
Explorer + center
center + Pin Dock
Explorer + center + Pin Dock
```

The document must:

- shrink rather than overflow;
- preserve `min-width: 0` through every flex ancestor;
- wrap prose naturally;
- keep wide content usable through local overflow;
- never force page-level horizontal scrolling;
- recover naturally when panels close.

Medium desktop with both sides open is a first-class case. Prefer inherently
fluid layout. Add a container query only when real testing proves a local
width-specific adjustment is necessary; do not create a new breakpoint system
speculatively.

## 13. Phone behavior

On phone, use essentially the full available transcript width.

Existing phone behavior remains authoritative:

- the pin dock remains desktop-only;
- Explorer remains a full-screen drill-in;
- the transcript remains the scroll surface;
- touch behavior remains unchanged;
- the page never scrolls sideways.

Use tighter gaps and restrained padding on small screens. Code, tables, and
other wide material own their horizontal overflow. Never reduce focusable
input/body sizes in a way that causes iOS focus zoom.

## 14. Typography

Typography is the primary visual feature.

### Body

Use a comfortable technical-document line height while retaining coding-session
density.

### Headings

Give Markdown headings a clear but restrained hierarchy:

- `h1`: response-level or major conclusion;
- `h2`: strong section;
- `h3`: subsection.

Do not make headings enormous. Existing Markdown heading elements remain real
headings; do not manufacture hierarchy from words.

### Paragraphs and lists

Use spacing that communicates structure without doubling transcript height.
Improve indentation, nested-list clarity, and task-list presentation.

### Blockquotes and rules

Blockquotes should read as quiet technical insets, below explicit registry
cards in emphasis. Horizontal rules are subtle section separators.

### Inline and block code

Retain existing code colors. Code blocks fit their lane, scroll locally when
needed, and never widen the transcript.

### Tables

Tables fit when possible, scroll locally when genuinely wide, and never widen
the workbench. Header and cell treatment may be polished using existing theme
tokens.

## 15. Registry components and artifacts

Do not create document variants of existing registry components. Preserve all
schemas, props, actions, and security handling.

Harmonize placement and geometry where useful:

- alignment;
- width behavior;
- border/radius language;
- spacing rhythm.

Do not homogenize every component or wrap `.rc`/artifact frames inside another
visible generic card. Artifacts retain their shell-owned sandbox frame and
action mediation.

## 16. Pinned content

Current pin behavior remains authoritative.

- A pinned render/artifact remains represented by its existing stub in the
  document position.
- The dock continues to use the same projected painting object.
- Unpinning restores the item naturally at that position.
- Grouping must not duplicate paintings or change update-in-place behavior.

## 17. Trust and security boundaries

Never blur:

```text
agent/model-authored content
```

and:

```text
Mirafold-owned trusted shell chrome or provider-faithful activity
```

Thinking, tools, notices, pickers, pins, permissions, and subagent chrome keep
their current semantics and visual identity.

Do not inspect text and infer status or layout semantics. In particular, never
implement rules such as:

```text
contains "passed" → success card
contains "warning" → warning surface
contains "next steps" → special section
```

Use only explicit Markdown structure, explicit registry messages, and existing
shell-owned row kinds.

Keep the current safe Markdown pipeline. Do not enable arbitrary raw HTML.
Existing URL handling, task-list accessibility, artifact sandboxing, and
sanitization assumptions remain unchanged.

## 18. Accessibility

Preserve the current accessibility model:

- `.render-zone` remains the conversation `role="log"`;
- `aria-live="off"` remains on the log;
- the separate announcer remains responsible for spoken turn summaries;
- streaming must not repeatedly announce the whole document;
- focus-to-prompt, text selection, keyboard scrolling, links, and shell
  controls remain intact;
- response wrappers do not become noisy landmarks;
- Markdown headings remain semantic headings;
- all new work remains axe-clean at enforced severities.

Add explicit regression coverage for transcript focus and announcement
behavior if grouping changes observable DOM mutation behavior.

## 19. Scroll behavior

Preserve terminal scrollback semantics:

- when already at the bottom, streaming continues following the tail;
- when the user scrolls up, streaming does not drag them down;
- returning to the bottom rearms following;
- opening/closing Explorer or the pin dock does not unexpectedly reset the
  user's transcript position;
- wrapper growth must not introduce continuous decorative height animation.

These are explicit acceptance tests, not assumptions implied by existing
coverage.

## 20. Animation

Streaming is already the animation.

The document may inherit current entry/component arrival behavior. Do not
animate every token, continuously animate section height, slide existing
components around, or add decorative motion that reads as latency. Preserve
reduced-motion behavior.

## 21. Expected file-level scope

Most executable work remains in the web client.

### `web/src/transcript-projection.ts`

No change is expected. It remains the source of projected visible rows. If a
presentation request appears to require changing its wire-to-view semantics,
stop and re-evaluate first.

### `web/src/response-document.ts`

Pure grouping of `OutputZoneRow[]` into ephemeral display items. Owns only
eligibility and hard/soft boundary classification. Direct unit coverage is
required.

### `web/src/components/ResponseDocument.tsx`

Small transparent layout wrapper only.

### `web/src/components/RenderZone.tsx`

Calls the grouping helper, maps display items, and reuses the existing
per-row renderer. It must not regain projection/state-machine logic.

### `web/src/styles/05-transcript.css`

Owns document measure, typography, rhythm, and response-specific responsive
structure. Phone overrides remain in the repository's single
`web/src/styles/15-phone.css` block.

### `web/src/registry/Md.tsx`

Change only if actual Markdown semantics require it. Prefer CSS to React
element overrides.

### Registry, protocol, adapters, and server

No production schema/protocol/adapter changes are expected. A deterministic
MockSession fixture may be extended solely to exercise the full browser path;
that fixture must emit existing `WireMsg` types only.

No new dependency is expected. If one is proposed, stop and apply the
repository dependency-cost test before proceeding.

## 22. Unit tests

Cover at minimum:

- assistant text → one response document;
- text/render/text/artifact/text → one document segment preserving exact row
  references and order;
- user prompt → hard boundary between response sequences;
- bang command → hard boundary;
- thinking/tool/fold/notice/picker/subagent deck → soft interruptions outside
  document segments without resetting `responseKey`;
- projected invisible nested records cannot appear in the helper input;
- original row array and row objects are not mutated;
- update-in-place rows retain IDs and references;
- stable segment keys while appending later eligible rows.

## 23. Browser E2E: deterministic composition turn

Add a deterministic mock response exercising:

```text
streaming prose
heading
paragraph
list
inline code
code block
rendered component
more streaming prose
wide content
second rendered component or artifact
final prose
```

Before `turn_end`, assert the document already exists and partial prose is
visible.

When a render arrives, assert that it appears immediately after prior prose.
When subsequent text arrives, assert that it appears beneath the component
without waiting for completion.

Hold a direct browser reference/property marker on the earlier component and
prove the same DOM node remains after later text streams. Also cover a soft
shell interruption so wrapper segmentation cannot silently remount earlier
content.

## 24. Browser E2E: workspace widths

Exercise normal desktop, Explorer open, pin dock open, and both simultaneously.
Assert:

- no page-level horizontal overflow;
- the document does not exceed available center width;
- prose wraps;
- rich components remain contained;
- the transcript follows only when already at the bottom;
- manual scroll position is preserved while content streams.

## 25. Browser E2E: phone

At a 390px-class viewport verify:

- the document fills available transcript width;
- no page side scrolling;
- headings remain readable;
- spacing remains dense;
- code/table overflow remains local;
- prompt, status, touch, and Explorer behavior remain unchanged.

## 26. Themes and visual baselines

Inspect representative dark and light themes during development. Do not fork
layout by theme.

Mirafold already has Ubuntu visual baselines. Add canonical live-document
states and update affected snapshots only after deliberate visual review.
Do not turn this feature into a new visual-infrastructure project.

## 27. Required verification gates

The blanket phrase "all suites green" must map to actual executable gates.
Required by completion:

- `yarn test`;
- `yarn typecheck`;
- `yarn build`;
- focused and full `yarn test:e2e` as appropriate;
- the managed browser-matrix constituent;
- the visual constituent with intentionally reviewed snapshots;
- `git diff --check`.

Known baseline fact: the combined local `yarn test:ui` wrapper has reproduced
the same timeout pattern on untouched `next`, while both constituent UI files
pass independently and CI runs them successfully. Do not misreport that
pre-existing wrapper behavior as a Live Document regression; use the exact
constituent/CI evidence unless the wrapper itself is separately repaired.

## 28. Implementation plan

This is an oversized feature in `PLAN.md`: Phase LD spans four passes, and
each numbered Step is one single-pass `$next` chunk.

### Step LD.1 — Structural composition

Introduce projected-row grouping and transparent response-document segments.
Preserve visible appearance as closely as possible. Prove streaming,
interleaving, exact order, hard/soft boundaries, mounted component identity,
pinning, replay, focus, and tail behavior before visual redesign.

### Step LD.2 — Opinionated visual treatment

Add two-lane measure, typography, Markdown hierarchy, document rhythm, and
intentional component alignment. Prose remains transparent by default. Update
and review dark/light canonical snapshots.

### Step LD.3 — Workspace responsiveness

Refine Explorer, file view, pin dock, combined-side, narrow-desktop, phone,
and wide-content cases. Add container-query behavior only if direct testing
proves it necessary.

### Step LD.4 — Restraint and regression polish

Exercise one-sentence, giant, text-only, render-heavy, tool-heavy, heading-rich,
heading-free, long-code, long-URL, long-filename, pin, replay, error, and every
theme case. Remove decoration or excess space that does not earn its place.

## 29. Non-goals

This phase does not include:

- new generative UI components or registry schema;
- protocol or production server/adapter changes;
- agent-prompt changes;
- asking models to emit HTML;
- semantic analysis of prose;
- replacing Markdown;
- changing pin semantics;
- redesigning Explorer, prompt, status, permissions, or themes;
- a new breakpoint system without evidence;
- visual-regression infrastructure from scratch;
- conventional chat bubbles;
- a classic-transcript toggle or dual rendering path.

## 30. Decision guardrails

Prefer the implementation that satisfies all of these:

1. Streaming stays sacred.
2. Exact visible order stays sacred.
3. Projected flat rows remain authoritative.
4. Explicit structure beats textual heuristics.
5. Theme stays Mirafold.
6. Rich components feel embedded rather than inserted.
7. Serious technical density matters.
8. Explorer and pinning are first-class workspace pressure.
9. Mounted identity includes ancestry, not only keys.
10. Visual unity does not require semantically absorbing shell chrome.
11. No extra abstraction without a concrete need.
12. The daring look comes from composition, not decoration.
13. There is one product direction, with no classic-view fallback.

## 31. Definition of done

- [x] Ordinary output looks deliberately composed without looking boxed-in.
- [x] A normal response reads visually as one live technical composition,
      including across soft shell interruptions.
- [x] Prose/render/prose/render/prose feels like one coherent answer.
- [x] One-sentence answers remain restrained.
- [x] The first document content appears before `turn_end`.
- [x] Registry components and artifacts appear immediately on their wire
      event.
- [x] Later text streams below earlier components without changing their
      mounted ancestry or identity.
- [x] No full-answer Markdown concatenation exists.
- [x] No protocol, registry schema, or production adapter change exists.
- [x] No textual semantic heuristics exist.
- [x] Existing pinning and update-in-place behavior remain correct.
- [x] Replay reconstructs the same visible transcript.
- [x] Tool, thinking, notice, picker, permission, and subagent trust identities
      remain distinct.
- [x] Explorer, pin dock, and both together apply pressure without overflow.
- [x] Phone has no page-level horizontal scrolling.
- [x] Wide content owns its local overflow.
- [x] Existing themes work without a document palette.
- [x] Focus, selection, keyboard scroll, tail following, and announcer behavior
      remain intact.
- [x] Required unit, browser, theme, visual, accessibility, and build gates
      pass with known baseline behavior reported literally.
- [x] Final review removes anything that feels padded, card-heavy, or
      theatrical.
- [x] No classic transcript toggle or second rendering mode exists.

Completion record (2026-08-19): the final dark/light complete-screen review
found no excess decoration to remove from the approved treatment. The closure
fixture proves a giant heading-free text response, long URL/filename/code,
render and artifact immediacy, reduced motion, selection/focus, capped
announcements, axe cleanliness, and unchanged response DOM/geometry through
all seven shipped themes. Existing full-suite scenarios prove render-heavy and
tool-heavy turns, pin/unpin, update-in-place, replay, errors, notices, pickers,
subagents, keyboard and tail scrolling, workspace pressure, and phone. Final
gates: Tier 1 867/867, typecheck, build, Tier 2 152/152, Tier 3 109/109,
managed browser matrix 3/3, visual constituent 6/6, and `git diff --check`.
The known combined local UI-wrapper timeout remains a baseline harness fact;
its two independently green constituents are the specified local gate.

## 32. Final product principle

> **Mirafold does not display an agent response as text with UI added to it.
> Mirafold lets the response itself become a live interface.**

Achieve that without giving up immediacy, ordering, density, fidelity, trust,
or reliability.
