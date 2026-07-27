import { test } from "node:test";
import assert from "node:assert/strict";
import { registryShapes } from "@registry-spec";
import { STATUS_GLYPH } from "./StatusList";

test("every schema status has a glyph — enum drift fails here, not as a blank pill", () => {
  const statusEnum = registryShapes["status-list"].items.element.shape.status;
  assert.deepEqual(Object.keys(STATUS_GLYPH).sort(), [...statusEnum.options].sort());
  // Distinct glyphs: the pill's state must survive with color stripped.
  assert.equal(new Set(Object.values(STATUS_GLYPH)).size, statusEnum.options.length);
});
