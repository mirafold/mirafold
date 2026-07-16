import { useEffect } from "react";
import { THEMES, parseThemeTokens, type ThemeAppearance } from "../themes/manifest";

// The settings card (S.4) — SHELL-OWNED UI, the one new chrome affordance of
// Phase S (the pill is locked unchanged). Centered modal over the scrim,
// same idiom as the pairing card; one section today (Theme), built to grow.
//
// Vite-only module: the swatch chips read each theme's real colors by
// importing the theme CSS as raw text (import.meta.glob), so a new theme's
// swatch appears with zero wiring here. That API doesn't exist under plain
// node/tsx — mount this from Shell only; never import it (even transitively)
// from a Tier-1-tested module. The e2e proves the chips carry real colors.
const rawThemeCss = import.meta.glob("../themes/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// bg, surface, accent, fg — enough chips to sell a palette at a glance.
const CHIP_TOKENS = ["--bg", "--surface", "--accent", "--fg"];

function chipColors(id: string): string[] {
  const tokens = parseThemeTokens(rawThemeCss[`../themes/${id}.css`] ?? "");
  return CHIP_TOKENS.map((t) => tokens.get(t) ?? "transparent");
}

const GROUPS: { label: string; appearance: ThemeAppearance }[] = [
  { label: "Light themes", appearance: "light" },
  { label: "Dark themes", appearance: "dark" },
];

export function ThemePicker({
  slots,
  onPick,
  onClose,
}: {
  /** The current slot choices — the checked row per group. */
  slots: Record<ThemeAppearance, string>;
  /** Applies a theme immediately and writes its appearance side's slot. */
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span className="glyph">❯</span>
          <span className="settings-title">settings</span>
          <button className="settings-close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <div className="settings-section-title">Theme</div>
        {GROUPS.map(({ label, appearance }) => (
          <div key={appearance} className="theme-group">
            <div className="theme-group-label">{label}</div>
            {THEMES.filter((t) => t.appearance === appearance).map((t) => {
              const slotted = slots[appearance] === t.id;
              return (
                <button
                  key={t.id}
                  className={"theme-row" + (slotted ? " is-slotted" : "")}
                  onClick={() => onPick(t.id)}
                >
                  <span className="theme-chips" aria-hidden="true">
                    {chipColors(t.id).map((c, i) => (
                      <span key={i} className="theme-chip" style={{ background: c }} />
                    ))}
                  </span>
                  <span className="theme-row-name">{t.displayName}</span>
                  {slotted && <span className="theme-row-check">✓</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
