import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILE_DROP_CHUNK_BYTES,
  FILE_DROP_MAX_BYTES,
  FILE_DROP_MAX_FILES,
  createFileDrop,
  quoteForPrompt,
  toBase64,
  type DroppedFile,
  type UploadEntry,
} from "./file-drop";

const file = (name: string, body: Uint8Array | string): DroppedFile => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    name,
    size: bytes.length,
    arrayBuffer: async () => {
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      return copy.buffer;
    },
  };
};

function harness() {
  const sent: { begin: [string, number][]; chunks: [string, string][]; aborts: string[] } = {
    begin: [],
    chunks: [],
    aborts: [],
  };
  const attached: [string, string][] = [];
  let states: UploadEntry[] = [];
  let mint = 0;
  const drop = createFileDrop({
    uploadBegin: (name, size) => {
      sent.begin.push([name, size]);
      return `u${++mint}`;
    },
    uploadChunk: (id, data) => sent.chunks.push([id, data]),
    uploadAbort: (id) => sent.aborts.push(id),
    onChange: (u) => (states = u),
    onAttached: (p, n) => attached.push([p, n]),
  });
  return { drop, sent, attached, states: () => states };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("toBase64 matches Buffer for sizes past the block boundary", () => {
  for (const n of [0, 1, 0x8000 - 1, 0x8000, 0x8000 + 1, 200_000]) {
    const bytes = new Uint8Array(n).map((_, i) => i % 251);
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"), `n=${n}`);
  }
});

test("quoteForPrompt quotes only when needed, escaping embedded quotes", () => {
  assert.equal(quoteForPrompt("/tmp/plain.txt"), "/tmp/plain.txt");
  assert.equal(quoteForPrompt("/tmp/my file.txt"), "'/tmp/my file.txt'");
  assert.equal(quoteForPrompt("/tmp/it's.txt"), "'/tmp/it'\\''s.txt'");
  assert.equal(quoteForPrompt("/tmp/$HOME.txt"), "'/tmp/$HOME.txt'");
});

test("a dropped file begins, chunks in bounded slices, and attaches on the reply", async () => {
  const { drop, sent, attached, states } = harness();
  const body = new Uint8Array(FILE_DROP_CHUNK_BYTES + 5).fill(7);
  drop.start([file("data.bin", body)]);
  await flush();
  assert.deepEqual(sent.begin, [["data.bin", body.length]]);
  assert.equal(sent.chunks.length, 2, "one full slice + the remainder");
  assert.equal(states()[0]?.status, "uploading");

  const consumed = drop.handle({
    type: "file_upload_done",
    id: "u1",
    path: "/tmp/mirafold-uploads/s/data.bin",
    name: "data.bin",
  });
  assert.equal(consumed, true);
  assert.deepEqual(attached, [["/tmp/mirafold-uploads/s/data.bin", "data.bin"]]);
  assert.equal(states().length, 0, "the chip clears on done");
});

test("a zero-byte file sends begin and no chunks", async () => {
  const { drop, sent } = harness();
  drop.start([file("empty.txt", "")]);
  await flush();
  assert.deepEqual(sent.begin, [["empty.txt", 0]]);
  assert.equal(sent.chunks.length, 0);
});

test("an oversize file is refused locally — bytes never read, nothing sent", () => {
  const { drop, sent, states } = harness();
  drop.start([
    { name: "huge.iso", size: FILE_DROP_MAX_BYTES + 1, arrayBuffer: async () => {
      throw new Error("must not be read");
    } },
  ]);
  assert.equal(sent.begin.length, 0);
  assert.equal(states()[0]?.status, "error");
  assert.match(states()[0]?.message ?? "", /too large/);
});

test("a drop past the file cap takes the first N and says so", async () => {
  const { drop, sent, states } = harness();
  drop.start(Array.from({ length: FILE_DROP_MAX_FILES + 3 }, (_, i) => file(`f${i}.txt`, "x")));
  await flush();
  assert.equal(sent.begin.length, FILE_DROP_MAX_FILES);
  const overflow = states().find((u) => u.status === "error");
  assert.match(overflow?.message ?? "", /first 8/);
});

test("a server error marks the chip; dismiss clears it", async () => {
  const { drop, states } = harness();
  drop.start([file("n.txt", "hello")]);
  await flush();
  drop.handle({ type: "file_upload_error", id: "u1", message: "file too large" });
  assert.equal(states()[0]?.status, "error");
  assert.equal(states()[0]?.message, "file too large");
  drop.dismiss(states()[0].id);
  assert.equal(states().length, 0);
});

test("a read failure aborts the upload and reports locally", async () => {
  const { drop, sent, states } = harness();
  drop.start([
    { name: "gone.txt", size: 5, arrayBuffer: async () => {
      throw new Error("NotReadableError");
    } },
  ]);
  await flush();
  assert.deepEqual(sent.aborts, ["u1"]);
  assert.equal(states()[0]?.status, "error");
  assert.match(states()[0]?.message ?? "", /could not read/);
});

test("a size that changed between drop and read aborts instead of desyncing", async () => {
  const { drop, sent } = harness();
  drop.start([
    { name: "shrunk.txt", size: 10, arrayBuffer: async () => new ArrayBuffer(4) },
  ]);
  await flush();
  assert.deepEqual(sent.aborts, ["u1"]);
  assert.equal(sent.chunks.length, 0);
});

test("unrelated messages are not consumed", () => {
  const { drop } = harness();
  assert.equal(drop.handle({ type: "pong" }), false);
});
