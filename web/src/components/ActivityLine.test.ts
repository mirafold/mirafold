import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityLine } from "./ActivityLine";

test("the activity label makes engine-chosen controls visible", () => {
  const html = renderToStaticMarkup(createElement(ActivityLine, { busy: true, label: "crm\u202e.lookup…" }));
  assert.ok(html.includes("‹U+202E›"));
  assert.ok(!html.includes("\u202e"));
});
