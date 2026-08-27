import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleControls } from "./visible-controls";

// AUDIT 2026-08-26: the permission bar showed a Bash command with U+202E
// exactly as the engine wrote it — reading as a different command than the
// one that would run. Controls are rendered as marked tokens, never hidden.
test("direction and invisible controls become visible tokens; ordinary text is untouched", () => {
  assert.equal(visibleControls("git status \u202e; rm -rf ~"), "git status ‹U+202E›; rm -rf ~");
  assert.equal(visibleControls("a\u200bb\u2066c\ufeffd\u061ce"), "a‹U+200B›b‹U+2066›c‹U+FEFF›d‹U+061C›e");
  assert.equal(visibleControls("plain — text, with 日本語 and emoji 🚀 and\ttabs\nnewlines"), "plain — text, with 日本語 and emoji 🚀 and\ttabs\nnewlines");
  assert.equal(visibleControls("\u0007bell\u001b[31mred"), "‹U+0007›bell‹U+001B›[31mred");
});
