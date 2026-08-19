import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePromptDraft } from "./prompt-draft";

test("mergePromptDraft: an empty prompt becomes the visible review draft", () => {
  assert.equal(mergePromptDraft("", "Explain this."), "Explain this.");
});

test("mergePromptDraft: existing user text is preserved byte-for-byte before the review context", () => {
  assert.equal(
    mergePromptDraft("Keep my first thought.  ", "File: \"src/a.ts\""),
    "Keep my first thought.  \n\nFile: \"src/a.ts\"",
  );
  assert.equal(mergePromptDraft("Already spaced\n\n", "More"), "Already spaced\n\nMore");
});
