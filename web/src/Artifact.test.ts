import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBridgeAction, wrap } from "./Artifact";

// R.4e: the artifact sandbox's pure functions, pinned by tests so flipping a
// defense fails loudly instead of silently shipping. parseBridgeAction is the
// gate between agent-authored script and the shell's action path; wrap() is
// what guarantees every artifact document carries the lockdown CSP and the
// nonce-closing boot script BEFORE any hostile content runs.

// ---- parseBridgeAction: what may leave the sandbox ------------------------

test("bridge parser accepts a well-formed prompt action", () => {
  assert.deepEqual(
    parseBridgeAction({ genui: 1, action: { kind: "prompt", text: "hello" } }),
    { kind: "prompt", text: "hello" },
  );
});

test("bridge parser accepts tool actions, with and without object args", () => {
  assert.deepEqual(parseBridgeAction({ genui: 1, action: { kind: "tool", name: "workspace_ls" } }), {
    kind: "tool",
    name: "workspace_ls",
    args: undefined,
  });
  assert.deepEqual(
    parseBridgeAction({ genui: 1, action: { kind: "tool", name: "t", args: { a: 1 } } }),
    { kind: "tool", name: "t", args: { a: 1 } },
  );
});

test("bridge parser drops state ops — they never leave the sandbox", () => {
  assert.equal(
    parseBridgeAction({ genui: 1, action: { kind: "state", op: "set", key: "x", value: "y" } }),
    null,
  );
});

test("bridge parser drops junk and malformed shapes", () => {
  for (const bad of [
    null,
    42,
    "prompt",
    [],
    {},
    { action: { kind: "prompt", text: "no genui stamp" } }, // missing stamp
    { genui: 2, action: { kind: "prompt", text: "wrong stamp" } },
    { genui: 1 }, // no action
    { genui: 1, action: null },
    { genui: 1, action: { kind: "prompt" } }, // no text
    { genui: 1, action: { kind: "prompt", text: 7 } },
    { genui: 1, action: { kind: "prompt", text: "   " } }, // blank
    { genui: 1, action: { kind: "tool" } }, // no name
    { genui: 1, action: { kind: "tool", name: 7 } },
    { genui: 1, action: { kind: "tool", name: "t", args: [1, 2] } }, // array args
    { genui: 1, action: { kind: "tool", name: "t", args: "s" } },
    { genui: 1, action: { kind: "tool", name: "x".repeat(201) } }, // name cap
  ]) {
    assert.equal(parseBridgeAction(bad), null, JSON.stringify(bad));
  }
});

test("bridge parser caps prompt text at 4000 chars", () => {
  const at = { genui: 1, action: { kind: "prompt", text: "x".repeat(4000) } };
  const over = { genui: 1, action: { kind: "prompt", text: "x".repeat(4001) } };
  assert.notEqual(parseBridgeAction(at), null);
  assert.equal(parseBridgeAction(over), null);
});

// ---- wrap(): the document every artifact actually gets --------------------

test("wrap() injects the lockdown CSP meta and it precedes the content", () => {
  const out = wrap("<b>content-marker</b>", "nonce-1");
  const csp = out.indexOf('http-equiv="Content-Security-Policy"');
  assert.notEqual(csp, -1, "CSP meta missing");
  assert.match(out, /default-src 'none'/);
  assert.ok(csp < out.indexOf("content-marker"), "CSP must come before the content");
});

test("wrap() injects the nonce-closing boot script before the content", () => {
  const out = wrap("<b>content-marker</b>", "nonce-abc123");
  const boot = out.indexOf('"nonce-abc123"');
  assert.notEqual(boot, -1, "boot script must close over the nonce");
  assert.ok(boot < out.indexOf("content-marker"), "boot script must come before the content");
  // The bridge stamps every outbound message; the host drops the unstamped.
  assert.match(out, /m\.genui=1;m\.nonce=N/);
});

test("wrap() puts the content in the body, inside the wrapper document", () => {
  const out = wrap("<b>content-marker</b>", "n");
  assert.match(out, /<body><b>content-marker<\/b><\/body><\/html>$/);
  assert.match(out, /^<!doctype html>/);
});
