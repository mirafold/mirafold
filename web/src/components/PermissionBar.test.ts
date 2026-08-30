import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionBar } from "./PermissionBar";

// AUDIT 2026-08-26: the strip is where the user decides whether a command
// runs, so an engine's direction override or invisible control character
// must show as a marked token, never act as itself (visible-controls.ts has
// the helper's own test). This pins that the bar routes BOTH the tool and
// the detail through it — the wiring, which the helper test cannot see.
test("the permission strip shows an ask's control characters as marked tokens, in the tool and in the detail", () => {
  const html = renderToStaticMarkup(
    createElement(PermissionBar, {
      asks: [{ id: "p1", tool: "Bash‮", detail: "echo safe ‮; rm -rf tmp" }],
      onAnswer: () => {},
    }),
  );
  assert.equal(html.includes("‮"), false, "a raw right-to-left override reached the markup");
  assert.match(html, /class="permission-tool">Bash‹U\+202E›</);
  assert.match(html, /class="permission-detail">echo safe ‹U\+202E›; rm -rf tmp</);
});
