// The theme manifest (S.2): the single source of truth for what themes exist
// and what a theme IS. Nothing else in the app ever names a theme — ids stamp
// `:root[data-theme]` and persist in settings; the picker (S.4) renders from
// THEMES; the Tier-1 guards (themes.test.ts) hold every theme file to
// THEME_TOKENS exactly. Adding a theme = one CSS file + one row here + the
// eyeball QA walk (PLAN Phase S).

export type ThemeAppearance = "light" | "dark";

export interface ThemeEntry {
  /** Stamped on `:root[data-theme]`, persisted in settings, names the CSS
      file (`web/src/themes/<id>.css`). Never shown to users. */
  id: string;
  /** What the picker shows. */
  displayName: string;
  /** Which side of the light/dark toggle selects this theme — a label, not
      a pairing: every theme is standalone (Phase S charter). */
  appearance: ThemeAppearance;
}

export const THEMES: ThemeEntry[] = [
  // "Mirafold" is the house theme (the dark default; id stays `dark` — ids
  // are load-bearing fallbacks, display names are free). The light default
  // is Standard Light, which took over the `light` id when the original
  // designed Light was dropped (2026-07-18 — see light.css header).
  { id: "dark", displayName: "Mirafold", appearance: "dark" },
  { id: "standard", displayName: "Standard", appearance: "dark" },
  { id: "light", displayName: "Standard Light", appearance: "light" },
  { id: "solarized-light", displayName: "Solarized Light", appearance: "light" },
  { id: "solarized-dark", displayName: "Solarized Dark", appearance: "dark" },
  { id: "gruvbox-dark", displayName: "Gruvbox Dark", appearance: "dark" },
  { id: "dracula", displayName: "Dracula", appearance: "dark" },
];

// Two-slot storage (S.3): the mode key predates slots and keeps its exact
// meaning — "light" | anything-else→dark, which side of the pill is active.
// Each side resolves to a theme id through its slot key. index.html's
// pre-paint script mirrors these key names by value (it can't import).
export const MODE_STORAGE_KEY = "mirafold-theme";
export function slotStorageKey(appearance: ThemeAppearance): string {
  return `mirafold-theme-${appearance}`;
}

/** The theme id a pill side resolves to: the stored slot choice when it
    names a manifest theme, else the side's built-in default (whose id
    equals the appearance label). Appearance fit is enforced where slots
    are WRITTEN (the picker); an unknown/stale stored id falls back rather
    than painting nothing. */
export function resolveSlot(appearance: ThemeAppearance, storedId: string | null): string {
  return THEMES.some((t) => t.id === storedId) ? (storedId as string) : appearance;
}

/** Extract a theme file's `--token: value` declarations. A theme file is
    flat declarations — this parser is the contract's reach, shared by the
    Tier-1 guards and the picker's swatch chips: anything fancier (nesting,
    @media) lands as a stray or a miss and forces a deliberate loosening
    here. */
export function parseThemeTokens(css: string): Map<string, string> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map<string, string>();
  for (const m of noComments.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
    tokens.set(m[1], m[2].trim());
  }
  return tokens;
}

// The token contract: every theme file defines EXACTLY these custom
// properties — no missing, no strays — enforced by themes.test.ts. Grouped
// as in the theme files. Structural CSS consumes only these names (plus the
// pinned set below); growing the contract means updating every theme file in
// the same change, which is exactly the loud failure we want.
export const THEME_TOKENS = [
  // surfaces
  "--bg",
  "--bg-inset",
  "--surface",
  "--surface-2",
  "--surface-3",
  "--surface-hover",
  "--inline-code-bg",
  // text
  "--fg",
  "--fg-strong",
  "--fg-body",
  "--fg-mid",
  "--fg-dim",
  "--fg-dimmer",
  "--fg-faint",
  // accents
  "--accent",
  "--info",
  "--warn-fg",
  "--error",
  // borders
  "--border",
  "--border-2",
  "--border-mid",
  "--border-hover",
  "--border-faint",
  "--border-ghost",
  // accent-tinted families
  "--ok-bg",
  "--ok-border",
  "--ok-border-strong",
  "--err-bg",
  "--err-border",
  "--err-border-strong",
  "--info-bg",
  "--info-border",
  "--info-border-strong",
  "--warn-bg",
  "--warn-bg-2",
  "--warn-border",
  "--warn-border-2",
  // misc
  "--overlay",
  "--selection",
  "--shadow-pop",
  "--shadow-card",
] as const;

// Pinned tokens: defined ONCE in base.css, dark in every theme (the
// #8-adjacent decision) — a theme file redefining one is a stray and fails
// the contract guard. The per-theme override door in the design stays
// unexercised (Phase S charter).
export const PINNED_TOKENS = [
  "--code-bg",
  "--code-fg",
  "--diff-add-bg",
  "--diff-add-fg",
  "--diff-add-border",
  "--diff-del-bg",
  "--diff-del-fg",
] as const;

/* ---- The Base16 porting recipe (S.2) ---------------------------------------

Base16 is the porting RECIPE, not the vocabulary (Phase S charter): a borrowed
theme is transcribed from its canonical published Base16 scheme
(https://github.com/chriskempson/base16 — 16 slots, base00–base0F) into the
semantic tokens above, then hand-tuned in the QA walk. Palettes aren't
copyrightable and the source projects are MIT; carry a source-attribution
comment in the theme file anyway.

Directions below read for a DARK scheme; for a LIGHT scheme the Base16 slots
already invert (base00 is the light background), so "toward base05" always
means "toward the foreground" — follow the spirit, not the arithmetic sign.
mix(a, b, n%) = blend n% of b into a; do it in any color tool, then eyeball.

surfaces
  --bg              base00
  --bg-inset        base00 nudged toward black (dark) / base01 (light) — a hair
                    deeper than --bg; it recedes behind inputs
  --surface         mix(base00, base01, ~50%) — cards sit just proud of --bg
  --surface-2       base01
  --surface-3       between --surface and --surface-2
  --surface-hover   --surface-2 nudged toward base02
  --inline-code-bg  base01, biased toward --bg-inset (it sits inside prose)

text (7 tiers from 2 slots — interpolate, don't invent hues)
  --fg              base05
  --fg-strong       base06
  --fg-body         mix(base05, base06, ~25%)
  --fg-mid          mix(base05, base04, ~50%)
  --fg-dim          base04
  --fg-dimmer       mix(base04, base03, ~50%)
  --fg-faint        base03

accents (semantic, not syntax — resist the scheme's exotic hue choices)
  --accent          base0B (green: go/success/identity)
  --info            base0D (blue)
  --warn-fg         base0A (yellow; darken toward base09 on light schemes
                    until it reads on --bg)
  --error           base08 (red)

borders (6 weights between --bg and the fg ramp)
  --border          mix(base00, base02, ~60%)
  --border-2        a step past --border toward base02
  --border-mid      base02
  --border-hover    mix(base02, base03, ~50%)
  --border-faint    mix(base00, base02, ~35%)
  --border-ghost    mix(base00, base02, ~30%) — the faintest visible rule

accent-tinted families (each = its accent sunk into the background)
  --ok-bg           mix(base00, base0B, ~12%)
  --ok-border       mix(base00, base0B, ~28%)
  --ok-border-strong mix(base00, base0B, ~45%)
  --err-*           same three mixes with base08
  --info-*          same three mixes with base0D
  --warn-bg         mix(base00, base0A, ~10%); --warn-bg-2 slightly deeper
  --warn-border     mix(base00, base0A, ~30%); --warn-border-2 a step stronger

misc
  --overlay         near-black at ~0.82 alpha — keep dark even in light themes
                    (a scrim is a scrim)
  --selection       --accent at ~0.25 alpha (dark) / ~0.20 (light)
  --shadow-pop      keep the stock values (0 4px 14px rgba(0,0,0,0.18))
  --shadow-card     keep the stock values (0 18px 60px rgba(0,0,0,0.5))

Syntax-highlight slots (base08–base0F beyond the four above) are unused: code
surfaces are pinned (base.css) and hljs github-dark owns code coloring.

After transcription: the guards catch mechanical drift (missing/stray tokens,
unreadable --fg/--bg); the QA walk (PLAN S.5) catches taste — terminal output,
tool blocks, diffs-on-pinned-dark, permission bar, onboarding, generative-UI
components — and hand-tunes the derived tiers where the recipe's output
misses. Record notable deviations in the theme file's header comment.
---------------------------------------------------------------------------- */
