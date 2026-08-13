import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Table } from "./Table";

const render = (props: object) => renderToStaticMarkup(createElement(Table as never, props));

test("rows render exactly one cell per column — surplus truncated, missing padded", () => {
  const html = render({
    columns: ["file", "lines"],
    rows: [
      ["a.ts", 10, "SURPLUS"], // a third cell would escape the two headers
      ["b.ts"], // a short row must not ragged-shift later columns
    ],
  });
  assert.ok(!html.includes("SURPLUS"), "surplus cell rendered past the header");
  const cells = html.match(/<td/g) ?? [];
  assert.equal(cells.length, 4, "every row renders columns.length cells");
});

test("number cells scan as a column: rc-table-num, string cells stay markdown", () => {
  const html = render({ columns: ["k", "v"], rows: [["**bold**", 42]] });
  assert.match(html, /class="rc-table-num"[^>]*>42/);
  assert.ok(html.includes("<strong>bold</strong>"), "string cells render inline markdown");
  assert.ok(!html.includes("rc-table-num\"><strong>"), "markdown cells never take the numeric class");
});

test("empty rows render a visible empty state, not a bare header", () => {
  const html = render({ columns: ["a"], rows: [] });
  assert.ok(html.includes("no rows"));
});
