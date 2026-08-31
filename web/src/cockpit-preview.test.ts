import { test } from "node:test";
import assert from "node:assert/strict";
import { cockpitPreviewText } from "./cockpit-preview";

test("BUGHUNT: an absent optional tail never claims the transcript is empty", () => {
  assert.equal(cockpitPreviewText(undefined), "No transcript preview available.");
  assert.equal(cockpitPreviewText({ text: "safe\u202Ename" }), "safe‹U+202E›name");
});
