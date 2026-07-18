// The welcome's inline brand mark (RenderZone.tsx) is a hand-kept copy of
// web/public/logo.svg — JSX can't consume the asset's markup directly, so
// this guard fails loudly on drift instead (the repo's hand-kept-mirror
// idiom, same as the relay contract guard). Editing the logo means editing
// both places in the same change; this test is what makes forgetting loud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const logo = readFileSync(join(here, "../../public/logo.svg"), "utf8");
const zone = readFileSync(join(here, "RenderZone.tsx"), "utf8");

test("the welcome's inline brand mark matches logo.svg", () => {
  const rect = logo.match(/<rect[^>]*\brx="([\d.]+)"[^>]*\bfill="([^"]+)"/);
  assert.ok(rect, "logo.svg lost its tile rect");
  assert.ok(zone.includes(`rx="${rect[1]}"`), "tile corner radius drifted");
  assert.ok(zone.includes(`fill="${rect[2]}"`), "tile color drifted");

  const stroke = logo.match(/<g[^>]*\bstroke="(#[0-9a-fA-F]+)"/);
  assert.ok(stroke, "logo.svg lost its stroke group");
  assert.ok(zone.includes(`stroke="${stroke[1]}"`), "stroke color drifted");

  // Every stroked shape: weight (JSX-cased) + full geometry, verbatim.
  const shapes = [...logo.matchAll(/<(?:polyline|line)\s+stroke-width="([\d.]+)"\s+([^/>]+?)\s*\/>/g)];
  assert.equal(shapes.length, 3, "logo.svg shape count changed — update the inline copy AND this guard");
  for (const [, width, attrs] of shapes) {
    assert.ok(zone.includes(`strokeWidth="${width}"`), `stroke width ${width} drifted`);
    for (const [, name, value] of attrs.matchAll(/([\w-]+)="([^"]+)"/g)) {
      assert.ok(zone.includes(`${name}="${value}"`), `${name}="${value}" drifted from logo.svg`);
    }
  }
});
