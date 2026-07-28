import { test } from "node:test";
import assert from "node:assert/strict";
import { startDaemon } from "../testing/itest-harness";

// The response headers the daemon puts on its own served page, over real HTTP.
// The header middleware runs BEFORE the auth gate, so every response carries
// them — a 403 is as good a probe as a 200.
//
// `connect-src` is the one with teeth: it is the only directive that limits
// where data can go OUT, so it is the wall in front of exfiltration if hostile
// code ever runs on the page (a future injection bug, or — the realistic one —
// a compromised package in the bundle). It used to read `'self' ws: wss:`;
// a bare scheme source matches ANY host on that scheme, so those two entries
// allowed a socket to any server on the internet, which is precisely what this
// directive exists to stop (2026-07-27 audit).

const csp = async (port: number): Promise<string> => {
  const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
  const header = res.headers.get("content-security-policy");
  assert.ok(header, "the shell page must carry a CSP");
  return header;
};

/** Pull one directive out of the policy for exact comparison. */
const directive = (policy: string, name: string): string | undefined =>
  policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));

test("connect-src names no wildcard scheme — same-origin only when no relay is set", async () => {
  const d = await startDaemon();
  try {
    const policy = await csp(d.port);
    assert.equal(directive(policy, "connect-src"), "connect-src 'self'");

    // The specific regression: a bare `ws:`/`wss:` entry is a wildcard over
    // every host on that scheme. Neither may reappear anywhere in the policy.
    assert.doesNotMatch(policy, /(^|[\s;])wss?:(\s|;|$)/, "no bare scheme source");

    // The rest of the policy is unchanged and still present.
    assert.equal(directive(policy, "default-src"), "default-src 'self'");
    assert.equal(directive(policy, "object-src"), "object-src 'none'");
    assert.equal(directive(policy, "frame-ancestors"), "frame-ancestors 'none'");
    assert.equal(directive(policy, "base-uri"), "base-uri 'self'");
  } finally {
    await d.stop();
  }
});

test("connect-src admits the CONFIGURED relay by exact origin, and nothing else", async () => {
  // A real ws(s) URL: the origin is allowed, its path is not carried into the
  // policy, and it is named exactly rather than as a scheme wildcard.
  const d = await startDaemon({ MIRAFOLD_RELAY_URL: "wss://relay.example.test/ws" });
  try {
    const policy = await csp(d.port);
    assert.equal(directive(policy, "connect-src"), "connect-src 'self' wss://relay.example.test");
    assert.doesNotMatch(policy, /(^|[\s;])wss?:(\s|;|$)/, "still no bare scheme source");
  } finally {
    await d.stop();
  }
});

test("a malformed or non-ws relay URL narrows the policy, never widens it", async () => {
  // A bad value must not become a source. `http://` is not a socket origin and
  // must not be admitted just because it parsed.
  for (const bad of ["garbage", "http://evil.example"]) {
    const d = await startDaemon({ MIRAFOLD_RELAY_URL: bad });
    try {
      assert.equal(
        directive(await csp(d.port), "connect-src"),
        "connect-src 'self'",
        `relay URL ${bad} must contribute nothing`,
      );
    } finally {
      await d.stop();
    }
  }
});
