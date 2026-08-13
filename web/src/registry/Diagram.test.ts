import { test } from "node:test";
import assert from "node:assert/strict";
import { diagramDoc } from "./Diagram";

test("diagramDoc: the frame document carries the runtime and nonce — never agent source", () => {
  const doc = diagramDoc("/*runtime*/", "nonce-123");
  assert.ok(doc.includes("/*runtime*/"), "runtime missing");
  assert.ok(doc.includes(JSON.stringify("nonce-123")), "nonce missing");
  assert.ok(doc.includes("securityLevel:'strict'"), "mermaid must run strict");
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /default-src 'none'/);
  // The structural guarantee: source arrives ONLY by postMessage. There is no
  // interpolation slot for it, so no diagram text can break out of the markup
  // — pinned by the builder's arity: runtime + nonce are its only inputs.
  assert.equal(diagramDoc.length, 2);
});

test("diagramDoc: the frame follows the app theme — transparent body, per-message init", () => {
  const doc = diagramDoc("r", "n");
  // The panel surface is the canvas: a hardcoded dark body would paint a
  // dark slab into light themes (2026-08-13 paintings audit).
  assert.match(doc, /html,body\{margin:0;background:transparent\}/);
  // mermaid.initialize runs INSIDE the message handler, so every render pass
  // (including a theme-switch re-post) carries the current dark/background.
  const handler = doc.slice(doc.indexOf("addEventListener('message'"));
  assert.ok(handler.includes("mermaid.initialize"), "init must ride each message");
});

test("diagramDoc: a hostile nonce can't escape its JSON string", () => {
  const doc = diagramDoc("r", '</script><script>alert(1)</script>');
  // JSON.stringify escapes the closing tag's slash — the raw sequence must
  // not appear as markup.
  assert.ok(!doc.includes('N="</script>'), "nonce broke out of its string literal");
});
