import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PinDock } from "./PinDock";
import { RenderBlock, RenderBoundary } from "../registry/RenderBlock";

// AUDIT 2026-08-26: a pinned painting that throws must not take the dock —
// or the shell above it — down. React only honors an error boundary in a
// live DOM (server rendering rethrows), so this walks the element tree the
// dock returns and pins the wiring: every pinned painting sits DIRECTLY
// inside a RenderBoundary with the dock's own fallback.

const elements = (node: ReactNode, out: ReactElement[] = []): ReactElement[] => {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement(node)) {
    out.push(node);
    elements((node.props as { children?: ReactNode }).children, out);
  }
  return out;
};

const noop = () => {};

test("every pinned painting is wrapped, directly, in a RenderBoundary carrying the dock's fallback", () => {
  const items = [
    { kind: "render" as const, renderId: "r1", component: "card", props: { title: "one", body: "b" } },
    { kind: "render" as const, renderId: "r2", component: "card", props: { title: "two", body: "b" } },
  ];
  // Called as a plain function: PinDock is hook-free, so its return value
  // is the element tree. (A hook added to PinDock would throw here — then
  // render it and walk the markup instead.)
  const tree = PinDock({ items, onUnpin: noop, onCollapse: noop, onAction: noop });
  const blocks = elements(tree).filter((el) => el.type === RenderBlock);
  assert.equal(blocks.length, 2, "one RenderBlock per pinned painting");
  const boundaries = elements(tree).filter((el) => el.type === RenderBoundary);
  assert.equal(boundaries.length, 2, "one boundary per pinned painting, not one around the whole dock");
  for (const boundary of boundaries) {
    const props = boundary.props as { fallback: ReactNode; children: ReactNode };
    assert.ok(isValidElement(props.children) && props.children.type === RenderBlock, "the block is the boundary's direct child");
    assert.ok(isValidElement(props.fallback) && (props.fallback.props as { className?: string }).className === "pin-dock-fallback");
  }
});

test("the boundary is transparent when a painting is healthy — it still paints through the dock", () => {
  const html = renderToStaticMarkup(
    createElement(PinDock, {
      items: [{ kind: "render", renderId: "r1", component: "card", props: { title: "Deploy status", body: "green" } }],
      onUnpin: noop,
      onCollapse: noop,
      onAction: noop,
    }),
  );
  assert.match(html, /Deploy status/);
  assert.doesNotMatch(html, /pin-dock-fallback/);
});
