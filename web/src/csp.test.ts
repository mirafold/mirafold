import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// AUDIT 2026-08-26: app.mirafold.com served this bundle with no CSP at all —
// every network guarantee the daemon's header gives was absent on the phone.
// The policy must travel with the bundle: the Pages `_headers` file carries
// the full policy, and index.html carries the host-independent directives in
// a <meta>, so no host can forget them.
const web = path.resolve(import.meta.dirname, "..");
const html = readFileSync(path.join(web, "index.html"), "utf8");
const headers = readFileSync(path.join(web, "public", "_headers"), "utf8");

const REQUIRED = ["frame-src 'self'", "img-src 'self' data:", "object-src 'none'", "base-uri 'self'", "form-action 'self'"];

test("index.html carries the host-independent CSP directives in a <meta>", () => {
  const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  assert.ok(meta, "no CSP meta");
  for (const d of REQUIRED) assert.ok(meta.includes(d), `meta lacks ${d}`);
  assert.ok(!/default-src|connect-src/.test(meta), "a <meta> must not restrict connect-src (the relay dial) or set default-src");
});

test("public/_headers carries the full policy for the static origin, aligned with the daemon's", () => {
  const csp = headers.match(/Content-Security-Policy: (.+)/)?.[1];
  assert.ok(csp, "no CSP in _headers");
  for (const d of [...REQUIRED, "default-src 'self'", "frame-ancestors 'none'", "connect-src 'self' wss://relay.mirafold.sh"]) {
    assert.ok(csp.includes(d), `_headers lacks ${d}`);
  }
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});
