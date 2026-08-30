import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COCKPIT_PANEL_STORAGE_KEY,
  cockpitPanelWasOpen,
  rememberCockpitPanel,
} from "./cockpit-panel-state";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

test("the cockpit open preference survives navigation until an explicit close", () => {
  const store = storage();
  assert.equal(cockpitPanelWasOpen(store), false);
  rememberCockpitPanel(true, store);
  assert.equal(store.values.get(COCKPIT_PANEL_STORAGE_KEY), "1");
  assert.equal(cockpitPanelWasOpen(store), true);
  rememberCockpitPanel(false, store);
  assert.equal(cockpitPanelWasOpen(store), false);
  assert.equal(store.values.has(COCKPIT_PANEL_STORAGE_KEY), false);
});
