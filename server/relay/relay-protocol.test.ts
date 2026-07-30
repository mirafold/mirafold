import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_PAIRING_CODE_LENGTH,
  mintPairingCode,
  resolvePairingCode,
} from "./relay-protocol";

// The pairing code is the only credential on the remote path, so the resolver
// must never let a guessable pin through — and must never weaken a minted code.

test("minted codes clear the minimum length and don't repeat", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const code = mintPairingCode();
    assert.ok(code.length >= MIN_PAIRING_CODE_LENGTH, `minted code too short: ${code}`);
    assert.match(code, /^[A-Za-z0-9_-]+$/); // URL-safe, QR/fragment-ready
    seen.add(code);
  }
  assert.equal(seen.size, 100);
});

test("a strong pinned code is honored verbatim", () => {
  const pin = "a".repeat(MIN_PAIRING_CODE_LENGTH);
  assert.deepEqual(resolvePairingCode(pin), { code: pin, weakPin: false });
});

test("a short pinned code is refused and replaced with a minted one", () => {
  const { code, weakPin, pinProblem } = resolvePairingCode("kyle123");
  assert.equal(weakPin, true);
  assert.equal(pinProblem, "short");
  assert.notEqual(code, "kyle123");
  assert.ok(code.length >= MIN_PAIRING_CODE_LENGTH);
});

// 2026-07-29 bughunt: a long pin with a space ("correct horse battery
// staple") passed the length-only check, paired the daemon fine — and the
// phone's fragment parser truncated it at the space, deriving a different
// pairId: an eternal "Desktop not reachable" with no warning anywhere.
test("a pinned code the pairing link can't carry is refused, not honored", () => {
  for (const pinned of ["correct horse battery staple", "sixteen&chars#ok!!", "trailing-space-code "]) {
    const { code, weakPin, pinProblem } = resolvePairingCode(pinned);
    assert.equal(weakPin, true, pinned);
    assert.equal(pinProblem, "charset", pinned);
    assert.notEqual(code, pinned);
  }
  // base64url-alphabet pins of honest length still pass verbatim.
  const ok = "abcDEF123_-abcDEF";
  assert.equal(resolvePairingCode(ok).code, ok);
});

test("no pin (unset or empty) mints silently — not a refusal", () => {
  for (const pinned of [undefined, ""]) {
    const { code, weakPin } = resolvePairingCode(pinned);
    assert.equal(weakPin, false);
    assert.ok(code.length >= MIN_PAIRING_CODE_LENGTH);
  }
});
