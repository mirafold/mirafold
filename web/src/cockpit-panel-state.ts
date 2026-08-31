export const COCKPIT_PANEL_STORAGE_KEY = "mirafold-cockpit-panel-open";

type CockpitStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function cockpitPanelWasOpen(storage: CockpitStorage = localStorage): boolean {
  return storage.getItem(COCKPIT_PANEL_STORAGE_KEY) === "1";
}

export function rememberCockpitPanel(open: boolean, storage: CockpitStorage = localStorage) {
  if (open) storage.setItem(COCKPIT_PANEL_STORAGE_KEY, "1");
  else storage.removeItem(COCKPIT_PANEL_STORAGE_KEY);
}
