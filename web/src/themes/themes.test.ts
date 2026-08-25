// Tier-1 theme guards (S.2): hold every theme file to the manifest's token
// contract so 6 (then 16) themes can't silently drift — a mangled palette
// fails here before a human ever looks at it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  THEMES,
  THEME_TOKENS,
  PINNED_TOKENS,
  resolveSlot,
  slotStorageKey,
  parseThemeTokens,
} from "./manifest";

const themesDir = dirname(fileURLToPath(import.meta.url));

function themeCss(id: string): string {
  return readFileSync(join(themesDir, `${id}.css`), "utf8");
}

// WCAG relative luminance + contrast ratio; --fg/--bg must be plain hex for
// this to work, which is itself part of the contract's floor.
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  assert.match(full, /^[0-9a-fA-F]{6}$/, `not a 6-digit hex color: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function contrast(hexA: string, hexB: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = hexToRgb(hex).map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

test("manifest is sane: unique ids, non-empty names", () => {
  assert.ok(THEMES.length >= 2);
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
  for (const t of THEMES) {
    assert.match(t.id, /^[a-z][a-z0-9-]*$/, `theme id must be a kebab slug: ${t.id}`);
    assert.ok(t.displayName.trim().length > 0, `displayName empty for ${t.id}`);
  }
});

test("manifest ids and theme files are a bijection", () => {
  const files = readdirSync(themesDir)
    .filter((f) => f.endsWith(".css") && f !== "base.css")
    .map((f) => f.replace(/\.css$/, ""))
    .sort();
  const ids = THEMES.map((t) => t.id).sort();
  assert.deepEqual(files, ids, "themes/*.css and manifest THEMES ids must match 1:1");
});

test("each theme file scopes itself to its own data-theme (dark owns bare :root)", () => {
  for (const t of THEMES) {
    const css = themeCss(t.id).replace(/\/\*[\s\S]*?\*\//g, "");
    if (t.id === "dark") {
      assert.match(css, /:root\s*\{/, "dark must style bare :root (the fallback identity)");
      assert.doesNotMatch(css, /data-theme/, "dark must not scope to a data-theme");
    } else {
      assert.match(
        css,
        new RegExp(`:root\\[data-theme="${t.id}"\\]\\s*\\{`),
        `${t.id}.css must scope to :root[data-theme="${t.id}"]`,
      );
    }
  }
});

test("every theme defines exactly the contract's tokens", () => {
  for (const t of THEMES) {
    const declared = new Set(parseThemeTokens(themeCss(t.id)).keys());
    const contract = new Set<string>(THEME_TOKENS);
    const missing = [...contract].filter((k) => !declared.has(k));
    const strays = [...declared].filter((k) => !contract.has(k));
    assert.deepEqual(missing, [], `${t.id}.css is missing contract tokens`);
    assert.deepEqual(strays, [], `${t.id}.css declares tokens outside the contract (pinned tokens live only in base.css)`);
  }
});

test("base.css defines exactly the pinned tokens", () => {
  const declared = [...parseThemeTokens(readFileSync(join(themesDir, "base.css"), "utf8")).keys()].sort();
  assert.deepEqual(declared, [...PINNED_TOKENS].sort());
});

// The structural stylesheets (styles/*.css) and every .tsx may consume only
// tokens some theme or base.css defines — a `var(--x)` naming an undefined
// property is invalid at computed-value time and silently resets the whole
// declaration (a border disappears, a background goes transparent).
test("styles and components consume only defined tokens", () => {
  const webDir = join(themesDir, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  const consumers = walk(webDir).filter(
    (file) => (file.endsWith(".css") && !file.includes("/themes/")) || file.endsWith(".tsx"),
  );
  const defined = new Set<string>([...THEME_TOKENS, ...PINNED_TOKENS]);
  for (const file of consumers) {
    if (!file.endsWith(".css")) continue;
    // Local custom properties a stylesheet declares for itself count too.
    for (const m of readFileSync(file, "utf8").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) defined.add(m[1]);
  }
  const undefinedUses: string[] = [];
  for (const file of consumers) {
    for (const m of readFileSync(file, "utf8").matchAll(/var\((--[a-z0-9-]+)/g)) {
      if (!defined.has(m[1])) undefinedUses.push(`${file.slice(webDir.length + 1)}: ${m[1]}`);
    }
  }
  assert.deepEqual(undefinedUses, []);
});

test("contract and pinned token lists don't overlap", () => {
  const overlap = THEME_TOKENS.filter((k) => (PINNED_TOKENS as readonly string[]).includes(k));
  assert.deepEqual(overlap, []);
});

// V.1 contrast floors (2026-07-18, raised same day after Kyle's second
// round: WCAG-shaped floors still strained his eyes). The benchmark is a
// stock terminal — near-white on near-black at 15:1+ for EVERYTHING — so
// primary text must clear 11:1 and even the faintest tier clears 4.5:1 (the
// old legal minimum is now the placeholder floor). Dark themes keep their
// surface stacks in a tight envelope of --bg so the worst-case backdrop
// stays near the canvas; every tier is checked against the WORST of the
// surfaces text really sits on.
const TEXT_SURFACES = [
  "--bg",
  "--surface",
  "--surface-2",
  "--surface-3",
  "--surface-hover",
  "--inline-code-bg",
] as const;

// Floors by role: fg/strong/body are full-session reading text
// (terminal-grade); mid is secondary prose; dim is metadata that's still
// read (timestamps, card footers, the F.2 notice line); dimmer is
// read-for-content too (thinking block, status bar, tool detail); faint is
// placeholders/carets/decorations — even those clear the old body-text
// minimum.
const TEXT_TIER_FLOORS: Record<string, number> = {
  "--fg-strong": 12,
  "--fg": 11,
  "--fg-body": 10.5,
  "--fg-mid": 8.5,
  "--fg-dim": 7,
  "--fg-dimmer": 5.5,
  "--fg-faint": 4.5,
};

test("contrast floors: every text tier clears its floor on every text surface, in every theme", () => {
  for (const t of THEMES) {
    const tokens = parseThemeTokens(themeCss(t.id));
    for (const [tier, floor] of Object.entries(TEXT_TIER_FLOORS)) {
      for (const surface of TEXT_SURFACES) {
        const ratio = contrast(tokens.get(tier)!, tokens.get(surface)!);
        assert.ok(
          ratio >= floor,
          `${t.id}: ${tier} on ${surface} is ${ratio.toFixed(2)}:1, below the ${floor}:1 floor`,
        );
      }
    }
  }
});

test("accent text clears 4.5:1 on every real text surface, in every theme", () => {
  // Accents render as real text (links, error prose, warn notices, status
  // words) — and, per a 2026-07-21 axe-core sweep, on the SAME card/badge
  // surfaces body text does (.onb-blocked, .demo-banner-badge on
  // --surface-2; .onb-agent-detail on --bg via a since-removed opacity
  // dim). Checking only --bg missed all three: each cleared 4.5:1 there but
  // fell short — 4.4, 4.41, 3.57 — on the surface actually rendered on.
  // Same TEXT_SURFACES list the tier floors use, for the same reason. The
  // same extension caught six more real gaps this same day, all fixed:
  // light/solarized-light's accent set nudged darker (2-7%), and
  // solarized-dark's accent set + dracula/gruvbox-dark's --error nudged
  // BRIGHTER (7-14%) — dark themes need the opposite direction, light text
  // moving further from a dark background, not closer to it.
  for (const t of THEMES) {
    const tokens = parseThemeTokens(themeCss(t.id));
    for (const accent of ["--accent", "--info", "--warn-fg", "--error"]) {
      for (const surface of TEXT_SURFACES) {
        const ratio = contrast(tokens.get(accent)!, tokens.get(surface)!);
        assert.ok(
          ratio >= 4.5,
          `${t.id}: ${accent} on ${surface} is ${ratio.toFixed(2)}:1, below the 4.5:1 floor`,
        );
      }
    }
  }
});

test("semantic text on its matching tint clears 4.5:1, in every theme", () => {
  // The status-list pills (2026-07-27) are the first surface to set the
  // semantic colors as TEXT on their own tint backgrounds (accent on the ok
  // tint, error on the err tint, …). The accent test above checks the text
  // surfaces only, so without this a theme could ship an unreadable pill and
  // nothing would fail. Checked for every theme, including future ones.
  const pairs: Array<[string, string]> = [
    ["--accent", "--ok-bg"],
    ["--error", "--err-bg"],
    ["--info", "--info-bg"],
    ["--warn-fg", "--warn-bg"],
  ];
  for (const t of THEMES) {
    const tokens = parseThemeTokens(themeCss(t.id));
    for (const [fg, bg] of pairs) {
      const ratio = contrast(tokens.get(fg)!, tokens.get(bg)!);
      assert.ok(
        ratio >= 4.5,
        `${t.id}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below the 4.5:1 floor`,
      );
    }
  }
});

test("pinned code/diff text clears its floors", () => {
  const base = parseThemeTokens(readFileSync(join(themesDir, "base.css"), "utf8"));
  const pairs: Array<[string, string, number]> = [
    ["--code-fg", "--code-bg", 11],
    ["--diff-add-fg", "--diff-add-bg", 6],
    ["--diff-del-fg", "--diff-del-bg", 6],
  ];
  for (const [fg, bg, floor] of pairs) {
    const ratio = contrast(base.get(fg)!, base.get(bg)!);
    assert.ok(ratio >= floor, `${fg} on ${bg} is ${ratio.toFixed(2)}:1, below ${floor}:1`);
  }
});

test("resolveSlot: stored manifest ids win, anything else falls back to the side's default", () => {
  // S.3 two-slot model. The built-in defaults' ids equal the appearance
  // labels — the fallback leans on that.
  assert.equal(resolveSlot("dark", null), "dark");
  assert.equal(resolveSlot("light", null), "light");
  assert.equal(resolveSlot("dark", "light"), "light"); // existence, not appearance — write side enforces fit
  assert.equal(resolveSlot("dark", "no-such-theme"), "dark");
  assert.equal(resolveSlot("light", ""), "light");
  for (const t of THEMES) assert.equal(resolveSlot(t.appearance, t.id), t.id);
});

test("slot storage keys derive from the mode key's namespace", () => {
  assert.equal(slotStorageKey("light"), "mirafold-theme-light");
  assert.equal(slotStorageKey("dark"), "mirafold-theme-dark");
});

// Value guard (R.7, 2026-07-16 audit / landed 2026-07-30): the contrast
// floors above force ~18 tokens per theme to parse as plain hex, but the
// REST — borders, the tinted families, --bg-inset, --warn-bg-2, and the
// misc rgba()/shadow tokens — would accept any CSS at all. A contributed
// theme could carry a working-but-weird value (url(...), var() indirection,
// an expression) in one of those slots. The shell CSP already blocks a
// fetch at runtime and a reviewer sees the diff; this guard makes `yarn
// test` reject it mechanically. Grammars are deliberately narrow — exactly
// the shapes the shipped themes use; a legitimate new shape loosens this
// ON PURPOSE, in a reviewed diff.
const VALUE_ALPHA_TOKENS = ["--overlay", "--selection"] as const;
const VALUE_SHADOW_TOKENS = ["--shadow-pop", "--shadow-card"] as const;
const HEX6 = /^#[0-9a-f]{6}$/i;
const RGBA = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)$/;
// One shadow layer: 2-4 lengths (unitless 0 or px) then an rgba()/hex color.
const SHADOW_LAYER =
  /^(?:-?(?:0|\d+(?:\.\d+)?px)\s+){2,4}(?:rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)|#[0-9a-f]{6})$/i;

/** Split a shadow list on layer commas — the ones OUTSIDE parentheses. */
function shadowLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      layers.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  layers.push(cur.trim());
  return layers;
}

test("every token VALUE parses under its slot's grammar, in every theme + base.css", () => {
  const hexOnly = THEME_TOKENS.filter(
    (t) =>
      !(VALUE_ALPHA_TOKENS as readonly string[]).includes(t) &&
      !(VALUE_SHADOW_TOKENS as readonly string[]).includes(t),
  );
  for (const t of THEMES) {
    const tokens = parseThemeTokens(themeCss(t.id));
    for (const name of hexOnly) {
      assert.match(
        tokens.get(name)!,
        HEX6,
        `${t.id}: ${name} must be a plain 6-digit hex color, got ${JSON.stringify(tokens.get(name))}`,
      );
    }
    for (const name of VALUE_ALPHA_TOKENS) {
      assert.match(
        tokens.get(name)!,
        RGBA,
        `${t.id}: ${name} must be rgba(r, g, b, a), got ${JSON.stringify(tokens.get(name))}`,
      );
    }
    for (const name of VALUE_SHADOW_TOKENS) {
      for (const layer of shadowLayers(tokens.get(name)!)) {
        assert.match(
          layer,
          SHADOW_LAYER,
          `${t.id}: ${name} layer ${JSON.stringify(layer)} isn't lengths-then-color`,
        );
      }
    }
  }
  // The pinned set is colors only, defined once in base.css.
  const base = parseThemeTokens(readFileSync(join(themesDir, "base.css"), "utf8"));
  for (const name of PINNED_TOKENS) {
    assert.match(
      base.get(name)!,
      HEX6,
      `base.css: ${name} must be a plain 6-digit hex color, got ${JSON.stringify(base.get(name))}`,
    );
  }
});

test("appearance labels match the palette: --bg is dark for dark themes, light for light", () => {
  for (const t of THEMES) {
    const [r, g, b] = hexToRgb(parseThemeTokens(themeCss(t.id)).get("--bg")!);
    const perceived = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (t.appearance === "dark") {
      assert.ok(perceived < 0.5, `${t.id} is labeled dark but --bg is light (${perceived.toFixed(2)})`);
    } else {
      assert.ok(perceived >= 0.5, `${t.id} is labeled light but --bg is dark (${perceived.toFixed(2)})`);
    }
  }
});
