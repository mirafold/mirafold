import { useRef } from "react";
import { THEMES, parseThemeTokens, type ThemeAppearance } from "../themes/manifest";
import { useEscapeKey } from "../use-escape";
import { useFocusTrap } from "../use-focus-trap";

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
// Parsed once: the raw CSS is fixed at build time.
const CHIP_TOKENS = ["--bg", "--surface", "--accent", "--fg"];
const chipColorsById = new Map(
  THEMES.map((t) => {
    const tokens = parseThemeTokens(rawThemeCss[`../themes/${t.id}.css`] ?? "");
    return [t.id, CHIP_TOKENS.map((k) => tokens.get(k) ?? "transparent")] as const;
  }),
);

// Names the dialog for a screen reader (A.2). A constant is safe: only one
// settings card is ever mounted.
const TITLE_ID = "settings-card-title";

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
  useEscapeKey(onClose);
  // Mounted only while open, so the trap is always active (A.3).
  const card = useRef<HTMLDivElement>(null);
  useFocusTrap(card, true);

  return (
    // Backdrop click-to-dismiss is a MOUSE convenience and deliberately stays
    // a plain div (A.2): the keyboard equivalents already exist — Escape
    // above, and the ✕ below — so making this a control would only park a
    // page-sized, meaningless stop in the tab order.
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        ref={card}
        tabIndex={-1}
      >
        <div className="settings-head">
          <span className="glyph" aria-hidden="true">
            ❯
          </span>
          <span className="settings-title" id={TITLE_ID}>
            settings
          </span>
          <button className="settings-close" onClick={onClose} title="Close (Esc)" aria-label="Close settings">
            ✕
          </button>
        </div>
        <div className="settings-section-title">Theme</div>
        {GROUPS.map(({ label, appearance }) => (
          <div key={appearance} className="theme-group" role="group" aria-label={label}>
            <div className="theme-group-label">{label}</div>
            {THEMES.filter((t) => t.appearance === appearance).map((t) => {
              const slotted = slots[appearance] === t.id;
              return (
                <button
                  key={t.id}
                  className={"theme-row" + (slotted ? " is-slotted" : "")}
                  onClick={() => onPick(t.id)}
                  // The ✓ is the only thing marking the slotted row on screen;
                  // aria-pressed is its text-free equivalent (same idiom as the
                  // status-bar pill, which is LOCKED and untouched).
                  aria-pressed={slotted}
                >
                  <span className="theme-chips" aria-hidden="true">
                    {chipColorsById.get(t.id)!.map((c, i) => (
                      <span key={i} className="theme-chip" style={{ background: c }} />
                    ))}
                  </span>
                  <span className="theme-row-name">{t.displayName}</span>
                  {slotted && (
                    <span className="theme-row-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
