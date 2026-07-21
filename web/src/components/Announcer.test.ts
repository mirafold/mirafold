import { test } from "node:test";
import assert from "node:assert/strict";
import { speechFromMarkdown, turnResponse } from "./Announcer";

// A.1: what a screen reader hears at turn_end. The cap and the no-prose
// fallback are the two edges — a silent turn (tool work only) must still
// announce something, and a huge dump must not read for minutes.

// The response is banked as raw markdown; spoken verbatim it voices its own
// syntax ("pound pound", "bar bar", "backtick"). speechFromMarkdown strips the
// markers to the prose they wrap, leaving the rendered transcript untouched.
test("speechFromMarkdown strips heading, emphasis, and inline code markers", () => {
  assert.equal(speechFromMarkdown("## Code review"), "Code review");
  assert.equal(speechFromMarkdown("**bold** and _italic_ and `code`"), "bold and italic and code");
});

test("speechFromMarkdown keeps link and image text, drops the URL", () => {
  assert.equal(speechFromMarkdown("see [the paper](https://x.com/p)"), "see the paper");
  assert.equal(speechFromMarkdown("![a diagram](img.png)"), "a diagram");
});

test("speechFromMarkdown unwraps list, task, and blockquote markers", () => {
  assert.equal(speechFromMarkdown("- one\n- two"), "one\ntwo");
  assert.equal(speechFromMarkdown("- [x] done\n- [ ] todo"), "done\ntodo");
  assert.equal(speechFromMarkdown("1. first\n2. second"), "first\nsecond");
  assert.equal(speechFromMarkdown("> quoted line"), "quoted line");
});

test("speechFromMarkdown drops code fences but keeps the code lines", () => {
  assert.equal(speechFromMarkdown("```ts\nconst x = 1;\n```"), "const x = 1;");
});

test("speechFromMarkdown flattens tables and drops separator/rule rows", () => {
  assert.equal(
    speechFromMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |"),
    "a, b\n1, 2",
  );
  assert.equal(speechFromMarkdown("above\n\n---\n\nbelow"), "above\n\nbelow");
});

test("turnResponse normalizes markdown before speaking", () => {
  assert.equal(
    turnResponse("## Title\n\nSome **prose** with `code`."),
    "Title\n\nSome prose with code.",
  );
});

test("turnResponse caps on the normalized length, not the raw markdown", () => {
  const spoken = turnResponse("**" + "z".repeat(5000) + "**");
  assert.ok(spoken.startsWith("z".repeat(4000)));
  assert.match(spoken, /the full text is in the transcript\.$/);
});

test("turnResponse speaks the response when there is prose", () => {
  assert.equal(turnResponse("  Here is the answer.  "), "Here is the answer.");
});

test("turnResponse falls back when the turn produced no prose", () => {
  assert.equal(turnResponse(""), "Turn complete.");
  assert.equal(turnResponse("   \n  "), "Turn complete.");
});

test("turnResponse caps a long response and points at the transcript", () => {
  const spoken = turnResponse("x".repeat(5000));
  assert.match(spoken, /the full text is in the transcript\.$/);
  assert.ok(spoken.startsWith("x".repeat(4000)));
  assert.ok(!spoken.includes("x".repeat(4001)));
});

test("turnResponse leaves a response exactly at the cap intact", () => {
  const exact = "y".repeat(4000);
  assert.equal(turnResponse(exact), exact);
});
