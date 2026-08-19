import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WireMsg } from "../protocol";
import type { SessionEntry } from "./registry";
import {
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_MAX_CHUNK_BYTES,
  FILE_UPLOAD_MAX_CONCURRENT,
  collisionFreePath,
  createUploadHandlers,
  safeUploadName,
  stagingDir,
} from "./upload-handlers";

const b64 = (s: string) => Buffer.from(s).toString("base64");

// A throwaway session identity per test: staging lands under the real
// os.tmpdir()/mirafold-uploads/<id>, so unique ids keep tests isolated and
// deletable.
let n = 0;
function harness(over: { remote?: boolean; kind?: string; entry?: boolean } = {}) {
  const sessionId = `uh-test-${process.pid}-${++n}`;
  const sent: WireMsg[] = [];
  const entry =
    over.entry === false
      ? null
      : ({ id: sessionId, kind: over.kind ?? "api-key" } as unknown as SessionEntry);
  const handlers = createUploadHandlers({
    viewport: (m) => sent.push(m),
    getEntry: () => entry,
    remote: over.remote ?? false,
  });
  const cleanup = () => {
    // Dispose first: it clears every armed stall reaper, so a test that
    // leaves an upload mid-flight can't hold the child process open.
    handlers.dispose();
    fs.rmSync(stagingDir(sessionId), { recursive: true, force: true });
  };
  return { handlers, sent, sessionId, cleanup };
}

test("a chunked upload stages the exact bytes and answers with the path", () => {
  const { handlers, sent, sessionId, cleanup } = harness();
  try {
    handlers.begin({ type: "file_upload_begin", id: "u1", name: "notes.txt", size: 11 });
    handlers.chunk({ type: "file_upload_chunk", id: "u1", data: b64("hello ") });
    assert.equal(sent.length, 0, "mid-upload is silent");
    handlers.chunk({ type: "file_upload_chunk", id: "u1", data: b64("world") });
    assert.equal(sent.length, 1);
    const done = sent[0];
    assert.equal(done.type, "file_upload_done");
    if (done.type !== "file_upload_done") return;
    assert.equal(done.name, "notes.txt");
    assert.ok(done.path.startsWith(stagingDir(sessionId)));
    assert.equal(fs.readFileSync(done.path, "utf8"), "hello world");
  } finally {
    cleanup();
  }
});

test("a zero-byte file is complete at begin", () => {
  const { handlers, sent, cleanup } = harness();
  try {
    handlers.begin({ type: "file_upload_begin", id: "u0", name: "empty.txt", size: 0 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "file_upload_done");
    if (sent[0].type === "file_upload_done") {
      assert.equal(fs.readFileSync(sent[0].path, "utf8"), "");
    }
  } finally {
    cleanup();
  }
});

test("same-name drops get collision suffixes, not overwrites", () => {
  const { handlers, sent, cleanup } = harness();
  try {
    for (const [id, body] of [
      ["a1", "first"],
      ["a2", "second"],
    ] as const) {
      handlers.begin({ type: "file_upload_begin", id, name: "dup.txt", size: body.length });
      handlers.chunk({ type: "file_upload_chunk", id, data: b64(body) });
    }
    const paths = sent.map((m) => (m.type === "file_upload_done" ? m.path : ""));
    assert.match(paths[0], /dup\.txt$/);
    assert.match(paths[1], /dup-2\.txt$/);
    assert.equal(fs.readFileSync(paths[0], "utf8"), "first");
    assert.equal(fs.readFileSync(paths[1], "utf8"), "second");
  } finally {
    cleanup();
  }
});

test("declared size over the cap refuses before any byte arrives", () => {
  const { handlers, sent, cleanup } = harness();
  try {
    handlers.begin({
      type: "file_upload_begin",
      id: "big",
      name: "big.bin",
      size: FILE_UPLOAD_MAX_BYTES + 1,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "file_upload_error");
  } finally {
    cleanup();
  }
});

test("more bytes than declared kills the upload", () => {
  const { handlers, sent, cleanup } = harness();
  try {
    handlers.begin({ type: "file_upload_begin", id: "u1", name: "n.txt", size: 3 });
    handlers.chunk({ type: "file_upload_chunk", id: "u1", data: b64("toolong") });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "file_upload_error");
    // The dead id answers "unknown upload" rather than resurrecting.
    handlers.chunk({ type: "file_upload_chunk", id: "u1", data: b64("x") });
    assert.equal(sent[1].type, "file_upload_error");
  } finally {
    cleanup();
  }
});

test("an oversized single chunk is refused even under the total cap", () => {
  const { handlers, sent, cleanup } = harness();
  try {
    const size = FILE_UPLOAD_MAX_CHUNK_BYTES + 1;
    handlers.begin({ type: "file_upload_begin", id: "u1", name: "n.bin", size });
    handlers.chunk({
      type: "file_upload_chunk",
      id: "u1",
      data: Buffer.alloc(size).toString("base64"),
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "file_upload_error");
  } finally {
    cleanup();
  }
});

test("a corrupt base64 chunk errors immediately — never a 30s stall-death", () => {
  const { handlers, sent, cleanup } = harness();
  try {
    // Buffer.from would silently DROP the invalid characters, under-count
    // `received`, and leave the upload to die by stall timeout; the grammar
    // check turns it into the typed error the module header promises. One
    // upload per corrupt shape — a failed upload is gone from `active`.
    const corrupt = ["!!not-base64!!", "abc", "QQ=X", "===="];
    corrupt.forEach((data, i) => {
      const id = `u${i + 1}`;
      handlers.begin({ type: "file_upload_begin", id, name: "n.bin", size: 8 });
      handlers.chunk({ type: "file_upload_chunk", id, data });
    });
    assert.deepEqual(
      sent,
      corrupt.map((_, i) => ({
        type: "file_upload_error",
        id: `u${i + 1}`,
        message: "malformed chunk",
      })),
    );
  } finally {
    cleanup();
  }
});

test("a chunk with no begin answers unknown-upload, never hangs correlation", () => {
  const { handlers, sent, cleanup } = harness();
  try {
    handlers.chunk({ type: "file_upload_chunk", id: "ghost", data: b64("x") });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "file_upload_error");
  } finally {
    cleanup();
  }
});

test("concurrency past the cap refuses the extra upload only", () => {
  const { handlers, sent, cleanup } = harness();
  try {
    for (let i = 0; i <= FILE_UPLOAD_MAX_CONCURRENT; i++) {
      handlers.begin({ type: "file_upload_begin", id: `c${i}`, name: "f.txt", size: 5 });
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "file_upload_error");
    if (sent[0].type === "file_upload_error") assert.equal(sent[0].id, `c${FILE_UPLOAD_MAX_CONCURRENT}`);
  } finally {
    cleanup();
  }
});

test("a duplicate begin id is refused without killing the in-flight original", () => {
  const { handlers, sent, sessionId, cleanup } = harness();
  try {
    handlers.begin({ type: "file_upload_begin", id: "u1", name: "keep.txt", size: 11 });
    handlers.begin({ type: "file_upload_begin", id: "u1", name: "imposter.txt", size: 3 });
    assert.deepEqual(sent, [
      { type: "file_upload_error", id: "u1", message: "duplicate upload id" },
    ]);
    // The original still completes — its state survived the collision.
    handlers.chunk({ type: "file_upload_chunk", id: "u1", data: b64("hello ") });
    handlers.chunk({ type: "file_upload_chunk", id: "u1", data: b64("world") });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].type, "file_upload_done");
    if (sent[1].type === "file_upload_done") {
      assert.equal(fs.readFileSync(sent[1].path, "utf8"), "hello world");
      assert.ok(sent[1].path.startsWith(stagingDir(sessionId)));
    }
  } finally {
    cleanup();
  }
});

test("no attached session refuses; a remote subscription viewport is gated", () => {
  const a = harness({ entry: false });
  a.handlers.begin({ type: "file_upload_begin", id: "u1", name: "n.txt", size: 1 });
  assert.equal(a.sent[0]?.type, "file_upload_error");

  const b = harness({ remote: true, kind: "subscription" });
  b.handlers.begin({ type: "file_upload_begin", id: "u1", name: "n.txt", size: 1 });
  assert.equal(b.sent[0]?.type, "file_upload_error");
  if (b.sent[0]?.type === "file_upload_error") assert.match(b.sent[0].message, /relay/);

  // The same remote viewport on an api-key session uploads fine.
  const c = harness({ remote: true, kind: "api-key" });
  try {
    c.handlers.begin({ type: "file_upload_begin", id: "u1", name: "n.txt", size: 2 });
    c.handlers.chunk({ type: "file_upload_chunk", id: "u1", data: b64("ok") });
    assert.equal(c.sent[0]?.type, "file_upload_done");
  } finally {
    c.cleanup();
  }
});

test("abort discards a partial silently; a hostile id is dropped whole", () => {
  const { handlers, sent, cleanup } = harness();
  try {
    handlers.begin({ type: "file_upload_begin", id: "u1", name: "n.txt", size: 10 });
    handlers.chunk({ type: "file_upload_chunk", id: "u1", data: b64("part") });
    handlers.abort({ type: "file_upload_abort", id: "u1" });
    assert.equal(sent.length, 0);
    // Post-abort chunks are unknown.
    handlers.chunk({ type: "file_upload_chunk", id: "u1", data: b64("more") });
    assert.equal(sent[0]?.type, "file_upload_error");
    // Bad id grammar: dropped with no reply at all.
    handlers.begin({ type: "file_upload_begin", id: "../evil", name: "n", size: 1 });
    assert.equal(sent.length, 1);
  } finally {
    cleanup();
  }
});

test("safeUploadName strips paths and control chars, never returns empty", () => {
  assert.equal(safeUploadName("/etc/passwd"), "passwd");
  assert.equal(safeUploadName("..\\..\\boot.ini"), "boot.ini");
  assert.equal(safeUploadName("a\x00b\x1fc.txt"), "abc.txt");
  assert.equal(safeUploadName(".."), "dropped-file");
  assert.equal(safeUploadName("   "), "dropped-file");
  assert.equal(safeUploadName(undefined), "dropped-file");
  assert.equal(safeUploadName("x".repeat(300)).length, 120);
});

test("collisionFreePath suffixes before the extension", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uh-collide-"));
  try {
    assert.equal(collisionFreePath(dir, "a.txt"), path.join(dir, "a.txt"));
    fs.writeFileSync(path.join(dir, "a.txt"), "");
    assert.equal(collisionFreePath(dir, "a.txt"), path.join(dir, "a-2.txt"));
    fs.writeFileSync(path.join(dir, "a-2.txt"), "");
    assert.equal(collisionFreePath(dir, "a.txt"), path.join(dir, "a-3.txt"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
