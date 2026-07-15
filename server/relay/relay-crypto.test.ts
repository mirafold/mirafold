import { test } from "node:test";
import assert from "node:assert/strict";
import {
  derivePair,
  frameCiphers,
  fromB64u,
  openHandshake,
  randomBytes,
  sealHandshake,
  toB64u,
} from "./relay-crypto";

// The E2E layer's guarantees, exercised directly — everything that must
// fail does fail (tamper, replay, reorder, wrong key, role reflection), and
// nothing the relay sees reveals the pairing code or a plaintext frame (R.3).

const CODE = "test-pairing-code-8c1d2e3f";

/** Both ends of a fresh channel, as the handshake would build them. */
async function channel() {
  const pair = await derivePair(CODE);
  const nonceC = randomBytes(32);
  const nonceD = randomBytes(32);
  const client = await frameCiphers(pair, nonceC, nonceD, "c");
  const daemon = await frameCiphers(pair, nonceC, nonceD, "d");
  return { pair, client, daemon };
}

test("base64url round-trips arbitrary bytes, including chunk-boundary sizes", () => {
  // getRandomValues caps at 64 KiB per call — big sizes get a pattern fill.
  for (const n of [0, 1, 12, 0x8000 - 1, 0x8000, 0x8000 + 1, 200_000]) {
    const buf = n <= 0x10000 ? randomBytes(n) : Uint8Array.from({ length: n }, (_, i) => (i * 7 + (i >> 8)) & 0xff);
    assert.deepEqual(fromB64u(toB64u(buf)), buf);
  }
});

test("pairId is deterministic and reveals nothing of the code", async () => {
  const a = await derivePair(CODE);
  const b = await derivePair(CODE);
  assert.equal(a.id, b.id);
  assert.ok(!CODE.includes(a.id) && !a.id.includes(CODE.slice(0, 8)));
  assert.notEqual((await derivePair(CODE + "x")).id, a.id);
});

test("frames round-trip both directions, unicode intact", async () => {
  const { client, daemon } = await channel();
  const up = JSON.stringify({ type: "prompt", text: "héllo → relay ✳" });
  assert.equal(await daemon.open(await client.seal(up)), up);
  const down = JSON.stringify({ type: "text_delta", text: "ĝenui" });
  assert.equal(await client.open(await daemon.seal(down)), down);
});

test("ciphertext contains no plaintext substrings", async () => {
  const { client } = await channel();
  const sealed = await client.seal(JSON.stringify({ type: "prompt", text: "SECRET-MARKER" }));
  assert.ok(!sealed.includes("SECRET-MARKER") && !sealed.includes("prompt"));
});

test("a tampered frame fails to open", async () => {
  const { client, daemon } = await channel();
  const sealed = await client.seal("payload");
  // Tamper an INTERIOR character, never the last one: base64's final char can
  // carry 2–4 padding bits that decoders silently ignore, so a last-char flip
  // sometimes decodes to identical bytes and the frame legitimately opens (a
  // real flake this test had). Every interior character is fully significant.
  const i = sealed.length - 8;
  const flip = (c: string) => (c === "A" ? "B" : "A");
  const tampered = sealed.slice(0, i) + flip(sealed[i]) + sealed.slice(i + 1);
  await assert.rejects(() => daemon.open(tampered));
});

test("a replayed frame fails to open (counter cannot repeat)", async () => {
  const { client, daemon } = await channel();
  const sealed = await client.seal("once");
  await daemon.open(sealed);
  await assert.rejects(() => daemon.open(sealed), /out of sequence/);
});

test("a reordered or dropped frame fails to open (counter is strict +1)", async () => {
  const { client, daemon } = await channel();
  await client.seal("swallowed by the relay"); // never delivered
  const second = await client.seal("arrives with a gap");
  await assert.rejects(() => daemon.open(second), /out of sequence/);
});

test("frames from a different connection's keys fail to open", async () => {
  const { client } = await channel();
  const { daemon: otherDaemon } = await channel(); // same code, fresh nonces
  await assert.rejects(async () => otherDaemon.open(await client.seal("cross-channel")));
});

test("a frame reflected back at its sender fails to open (directional keys)", async () => {
  const { client } = await channel();
  const sealed = await client.seal("bounce");
  await assert.rejects(() => client.open(sealed));
});

test("handshake round-trips per role and rejects the wrong role or key", async () => {
  const pair = await derivePair(CODE);
  const nonce = randomBytes(32);
  const hello = await sealHandshake(pair, "c", nonce);
  assert.deepEqual(await openHandshake(pair, "c", hello), nonce);
  // Reflection: a client hello must not pass as a daemon reply.
  await assert.rejects(() => openHandshake(pair, "d", hello));
  // Wrong pairing code: fails outright — this is the wrong-code pairing path.
  const wrong = await derivePair("some-other-code-entirely");
  await assert.rejects(() => openHandshake(wrong, "c", hello));
});
