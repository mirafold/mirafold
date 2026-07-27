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

test("diagramDoc: a hostile nonce can't escape its JSON string", () => {
  const doc = diagramDoc("r", '</script><script>alert(1)</script>');
  // JSON.stringify escapes the closing tag's slash — the raw sequence must
  // not appear as markup.
  assert.ok(!doc.includes('N="</script>'), "nonce broke out of its string literal");
});
