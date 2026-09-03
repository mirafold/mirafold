import { useEffect, useState } from "react";
import {
  MODE_STORAGE_KEY,
  THEMES,
  resolveSlot,
  slotStorageKey,
  type ThemeAppearance,
} from "../themes/manifest";

/**
 * The theme, as shell-owned UI state: the mode is which side of the pill is
 * active; each side resolves to a theme id through its settings slot
 * (defaults: the built-in pair). index.html applies the stored choice before
 * first paint (no flash); this keeps the attribute and storage in sync.
 * Picking a theme fills its appearance side's slot and switches to that side
 * so the pick paints immediately — picking is seeing.
 */
export function useThemeSlots() {
  const [mode, setMode] = useState<ThemeAppearance>(() =>
    localStorage.getItem(MODE_STORAGE_KEY) === "light" ? "light" : "dark",
  );
  const [slots, setSlots] = useState<Record<ThemeAppearance, string>>(() => ({
    light: resolveSlot("light", localStorage.getItem(slotStorageKey("light"))),
    dark: resolveSlot("dark", localStorage.getItem(slotStorageKey("dark"))),
  }));
  useEffect(() => {
    document.documentElement.dataset.theme = slots[mode];
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    localStorage.setItem(slotStorageKey("light"), slots.light);
    localStorage.setItem(slotStorageKey("dark"), slots.dark);
  }, [mode, slots]);
  const pickTheme = (id: string) => {
    const entry = THEMES.find((t) => t.id === id);
    if (!entry) return;
    setSlots((s) => ({ ...s, [entry.appearance]: id }));
    setMode(entry.appearance);
  };
  const toggleMode = () => setMode((m) => (m === "dark" ? "light" : "dark"));
  return { mode, slots, pickTheme, toggleMode };
}
