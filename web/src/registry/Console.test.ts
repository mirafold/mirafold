import { test } from "node:test";
import assert from "node:assert/strict";
import { ansiSpans } from "./Console";

test("ansiSpans: plain text passes through as one unstyled span", () => {
  assert.deepEqual(ansiSpans("hello\nworld"), [{ text: "hello\nworld" }]);
});

test("ansiSpans: SGR colors open, reset closes, bold composes", () => {
  assert.deepEqual(ansiSpans("ok \x1b[31mFAIL\x1b[0m done"), [
    { text: "ok " },
    { text: "FAIL", className: "ansi-red" },
    { text: " done" },
  ]);
  assert.deepEqual(ansiSpans("\x1b[1;32mPASS\x1b[0m"), [
    { text: "PASS", className: "ansi-green ansi-bold" },
  ]);
  // A bare ESC[m is reset (empty parameter = 0), and bright colors map.
  assert.deepEqual(ansiSpans("\x1b[91mhot\x1b[mcold"), [
    { text: "hot", className: "ansi-bright-red" },
    { text: "cold" },
  ]);
});

test("ansiSpans: 256/truecolor selectors render default ink, arguments consumed", () => {
  // 38;5;196 (256-color red): we don't map the cube — text must still show,
  // uncolored, and '5'/'196' must not leak into the text or the state.
  assert.deepEqual(ansiSpans("\x1b[38;5;196mdeep\x1b[0m"), [{ text: "deep" }]);
  assert.deepEqual(ansiSpans("\x1b[38;2;255;0;0mtrue\x1b[0m"), [{ text: "true" }]);
});

test("ansiSpans: non-SGR escapes and control bytes strip; \\n and \\t survive", () => {
  // Cursor moves, OSC title set, OSC 8 hyperlink, a BEL, a stray ESC pair.
  const raw = "\x1b[2J\x1b[Ha\x1b]0;title\x07\tb\x1b]8;;http://x\x1b\\c\x07\nd";
  assert.deepEqual(ansiSpans(raw), [{ text: "a\tb" + "c\nd" }]);
});

test("ansiSpans: adjacent same-style runs merge into one span", () => {
  const spans = ansiSpans("\x1b[31ma\x1b[31mb\x1b[0m");
  assert.deepEqual(spans, [{ text: "ab", className: "ansi-red" }]);
});

// The clip boundary (2026-07-28 fix): a cut landing inside an escape sequence
// must not leak the sequence's tail as literal text.
test("clipping mid-escape-sequence drops the partial sequence, not just its head", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Console } = await import("./Console");
  const CLIP = 200_000; // Console.tsx's CONSOLE_CLIP
  // Place the cut two chars into "\x1b[31m": the clipped text ends "\x1b[3".
  const output = "x".repeat(CLIP - 3) + "\x1b[31mred text past the clip";
  const html = renderToStaticMarkup(createElement(Console as never, { output }));
  assert.ok(html.includes("output clipped"), "the clip note still shows");
  // Unfixed, stripOtherEscapes ate only "\x1b[" and the residue rendered as
  // literal "x…x3"; fixed, the clipped text is the x-run alone.
  assert.ok(!/x3/.test(html), "no escape-sequence tail leaks as literal text");
});
