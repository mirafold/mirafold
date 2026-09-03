import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_INTERACTIVE_REVIEW_LINES } from "../../workspace/change-review";
import { ReviewDiff } from "./ReviewDiff";

const renderAddedLines = (count: number): { html: string; elapsedMs: number } => {
  const after = Array.from({ length: count }, (_, index) => `const value${index} = ${index};`).join("\n");
  const started = performance.now();
  const html = renderToStaticMarkup(
    createElement(ReviewDiff, {
      state: { kind: "diff", path: "large.ts", before: "", after, revision: "fixture" },
      phone: false,
      onCreateDraft: () => {},
      onSelectionChange: () => {},
      onNoticeChange: () => {},
    }),
  );
  return { html, elapsedMs: performance.now() - started };
};

test("CR.4 interactive review highlights a large diff once within its render budget", () => {
  const { html, elapsedMs } = renderAddedLines(MAX_INTERACTIVE_REVIEW_LINES);
  assert.equal((html.match(/role="option"/g) ?? []).length, MAX_INTERACTIVE_REVIEW_LINES);
  assert.match(html, /hljs-keyword/);
  // Regression provenance: one Markdown/highlight pipeline per row took
  // 5.9s for this fixture; the shared pipeline measured 0.4s. Four seconds
  // leaves broad machine headroom while still catching the proven failure.
  assert.ok(elapsedMs < 4_000, `interactive review render took ${Math.round(elapsedMs)}ms`);
});

test("CR.4 an over-budget diff falls back before mounting selectable rows", () => {
  const { html } = renderAddedLines(MAX_INTERACTIVE_REVIEW_LINES + 1);
  assert.match(html, /Too many lines for interactive review/);
  assert.doesNotMatch(html, /role="option"/);
});
