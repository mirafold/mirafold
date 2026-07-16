import { test } from "node:test";
import assert from "node:assert/strict";
import { tokens } from "./StatusBar";

test("tokens abbreviates counts by magnitude", () => {
  assert.equal(tokens(0), "0");
  assert.equal(tokens(999), "999");
  assert.equal(tokens(1500), "1.5k");
  assert.equal(tokens(12000), "12k");
  assert.equal(tokens(2_500_000), "2.5M");
});
