// Phase R.3 — per-pair end-to-end encryption for the relay path. The relay
// operator (us, or any self-hoster) must not be able to read frames: the
// pairing code never leaves the two endpoints (the relay is given only its
// hash, for matching), every frame is AES-256-GCM under keys only the
// endpoints can derive, and anything that fails to authenticate — tampered,
// replayed, reordered, or wrong-key — throws, so callers fail closed.
//
// WebCrypto only (globalThis.crypto), no node imports: this exact module runs
// in the browser (via the @relay-crypto alias) and in the daemon (Node ≥ 20).
//
// Scheme, v1:
//   pairId   = b64url(SHA-256(code)[0..16))          — what the relay sees
//   hsKey    = HKDF(code, salt="genui-relay v1", info="hs")      — handshake
//   handshake: client sends AEAD(hsKey, aad="hs-c", 32 random bytes);
//              daemon replies AEAD(hsKey, aad="hs-d", 32 random bytes)
//   frame keys = HKDF(code, salt=nonceC‖nonceD, info="c2d"/"d2c") — fresh per
//              connection, so ciphertext recorded from an old connection can
//              never be replayed into a new one (a replayed prompt or bang
//              would otherwise re-execute)
//   frames   = AEAD(directional key, iv = 8-byte strict +1 counter) — one
//              sender per key, so counter ivs can never collide; the counter
//              check kills replay/reorder/drop within the connection
//   Not provided (possible v2, ECDH handshake): forward secrecy — leak the
//   pairing code later and recorded traffic opens. Codes are per-launch by
//   default, which bounds that window.

const VERSION = "genui-relay v1";

// TS ≥5.7 types BufferSource as backed by a real ArrayBuffer; plain
// `Uint8Array` widens to ArrayBufferLike and gets rejected. Everything this
// module makes is ArrayBuffer-backed, so carry that in the type.
type Bytes = Uint8Array<ArrayBuffer>;
const subtle = () => crypto.subtle;
const utf8 = (s: string) => new TextEncoder().encode(s);

// --- base64url over Uint8Array, chunked (frames can be ~1 MB; a spread into
// String.fromCharCode would blow the argument limit).
export function toB64u(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(
      null,
      buf.subarray(i, i + 0x8000) as unknown as number[],
    );
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64u(s: string): Bytes {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

export function randomBytes(n: number): Bytes {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

/** Everything derivable from the pairing code. `id` is all the relay gets. */
export type PairSecret = { id: string; hkdf: CryptoKey; hs: CryptoKey };

export async function derivePair(code: string): Promise<PairSecret> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", utf8(code)));
  const hkdf = await subtle().importKey("raw", utf8(code), "HKDF", false, ["deriveKey"]);
  const hs = await subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(VERSION), info: utf8("hs") },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { id: toB64u(digest.subarray(0, 16)), hkdf, hs };
}

const aead = async (key: CryptoKey, iv: Bytes, aad: string, data: Bytes): Promise<Bytes> =>
  new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, data),
  );
const openAead = async (key: CryptoKey, iv: Bytes, aad: string, data: Bytes): Promise<Bytes> =>
  new Uint8Array(
    await subtle().decrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, data),
  );

/**
 * Handshake frames ride the low-volume handshake key with random ivs; the aad
 * pins the role so a client hello can never be reflected back as a daemon
 * reply. The payload is that side's 32-byte session nonce.
 */
export async function sealHandshake(
  pair: PairSecret,
  role: "c" | "d",
  nonce: Bytes,
): Promise<string> {
  const iv = randomBytes(12);
  const ct = await aead(pair.hs, iv, `hs-${role}`, nonce);
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64u(out);
}
export async function openHandshake(
  pair: PairSecret,
  role: "c" | "d",
  frame: string,
): Promise<Bytes> {
  const buf = fromB64u(frame);
  return openAead(pair.hs, buf.subarray(0, 12), `hs-${role}`, buf.subarray(12));
}

/**
 * The per-connection frame cipher: seal with this side's directional key and
 * a strict +1 counter iv; open the peer's frames enforcing the peer's own
 * strict +1 counter — any gap, repeat, reorder, or forgery throws.
 */
export class FrameCipher {
  private sendCounter = 0n;
  private recvCounter = 0n;
  constructor(
    private sendKey: CryptoKey,
    private recvKey: CryptoKey,
  ) {}

  private static ivFor(counter: bigint): Bytes {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, counter);
    return iv;
  }

  async seal(text: string): Promise<string> {
    const iv = FrameCipher.ivFor(++this.sendCounter);
    const ct = await aead(this.sendKey, iv, "frame", utf8(text));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return toB64u(out);
  }

  async open(frame: string): Promise<string> {
    const buf = fromB64u(frame);
    const iv = buf.subarray(0, 12);
    const counter = new DataView(iv.buffer, iv.byteOffset).getBigUint64(4);
    if (counter !== this.recvCounter + 1n) {
      throw new Error("relay frame out of sequence");
    }
    const plain = await openAead(this.recvKey, iv, "frame", buf.subarray(12));
    this.recvCounter = counter; // only after authentication
    return new TextDecoder().decode(plain);
  }
}

/** Derive this side's FrameCipher from the two handshake nonces. */
export async function frameCiphers(
  pair: PairSecret,
  nonceC: Uint8Array,
  nonceD: Uint8Array,
  side: "c" | "d",
): Promise<FrameCipher> {
  const salt = new Uint8Array(nonceC.length + nonceD.length);
  salt.set(nonceC);
  salt.set(nonceD, nonceC.length);
  const key = (info: string) =>
    subtle().deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: utf8(info) },
      pair.hkdf,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  const [c2d, d2c] = await Promise.all([key("c2d"), key("d2c")]);
  return side === "c" ? new FrameCipher(c2d, d2c) : new FrameCipher(d2c, c2d);
}
