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
  parseThemeTokens as parseTokens,
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
    const declared = new Set(parseTokens(themeCss(t.id)).keys());
    const contract = new Set<string>(THEME_TOKENS);
    const missing = [...contract].filter((k) => !declared.has(k));
    const strays = [...declared].filter((k) => !contract.has(k));
    assert.deepEqual(missing, [], `${t.id}.css is missing contract tokens`);
    assert.deepEqual(strays, [], `${t.id}.css declares tokens outside the contract (pinned tokens live only in base.css)`);
  }
});

test("base.css defines exactly the pinned tokens", () => {
  const declared = [...parseTokens(readFileSync(join(themesDir, "base.css"), "utf8")).keys()].sort();
  assert.deepEqual(declared, [...PINNED_TOKENS].sort());
});

test("contract and pinned token lists don't overlap", () => {
  const overlap = THEME_TOKENS.filter((k) => (PINNED_TOKENS as readonly string[]).includes(k));
  assert.deepEqual(overlap, []);
});

test("contrast floor: --fg on --bg is at least 4.5:1 in every theme", () => {
  for (const t of THEMES) {
    const tokens = parseTokens(themeCss(t.id));
    const ratio = contrast(tokens.get("--fg")!, tokens.get("--bg")!);
    assert.ok(
      ratio >= 4.5,
      `${t.id}: --fg on --bg contrast is ${ratio.toFixed(2)}:1, below the 4.5:1 floor`,
    );
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

test("appearance labels match the palette: --bg is dark for dark themes, light for light", () => {
  for (const t of THEMES) {
    const [r, g, b] = hexToRgb(parseTokens(themeCss(t.id)).get("--bg")!);
    const perceived = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (t.appearance === "dark") {
      assert.ok(perceived < 0.5, `${t.id} is labeled dark but --bg is light (${perceived.toFixed(2)})`);
    } else {
      assert.ok(perceived >= 0.5, `${t.id} is labeled light but --bg is dark (${perceived.toFixed(2)})`);
    }
  }
});
