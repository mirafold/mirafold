import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderBlock } from "./RenderBlock";

// The guarded dispatch (PLAN 1.4): the wire's `component` is a plain string,
// so ANY string must degrade to the fallback — including Object.prototype
// keys, which a plain index lookup would resolve truthy and then crash on
// above the error boundary (2026-07-28 review).

const render = (component: string, props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(RenderBlock, { component, props, renderId: "r1", onAction: () => {} }),
  );

test("an unknown component name degrades to the fallback", () => {
  const html = render("no-such-component", { a: 1 });
  assert.ok(html.includes("rc-fallback"));
  assert.ok(html.includes("unknown component"));
});

test("prototype-key component names degrade to the fallback, not a crash", () => {
  for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
    const html = render(name, { a: 1 });
    assert.ok(html.includes("rc-fallback"), `${name} must hit the fallback`);
    assert.ok(html.includes("unknown component"), `${name} must read as unknown`);
  }
});

test("schema-invalid props degrade to the fallback", () => {
  const html = render("progress", { label: "p", percent: 200 });
  assert.ok(html.includes("rc-fallback"));
  assert.ok(html.includes("invalid props"));
});

test("a valid instruction still renders the component", () => {
  const html = render("progress", { label: "deploy", percent: 40 });
  assert.ok(html.includes("rc-progress"));
  assert.ok(!html.includes("rc-fallback"));
});
