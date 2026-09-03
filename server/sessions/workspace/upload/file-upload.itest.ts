import path from "node:path";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDaemon, createSession, type Daemon } from "../../../testing/itest-harness";
import { FILE_UPLOAD_MAX_BYTES } from "./upload-handlers";

// Phase FD over a REAL socket: a chunked upload lands byte-exact in the
// session's staging dir and the reply path is where the bytes actually are —
// the whole point of the feature is that path's honesty, so the proof reads
// the disk, not the handler. Abuse paths (oversize, overflow) get typed
// error replies on the same live connection, and the connection keeps
// working afterward.

let d: Daemon;

before(async () => {
  d = await startDaemon();
});
after(async () => {
  await d.stop();
});

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

test("FD.1: chunked upload over a real socket stages exact bytes at the replied path", async () => {
  const { client, sessionId } = await createSession(d.port);

  let staged: string | undefined;
  try {
    // Three chunks incl. multibyte content — byte math, not string math.
    const body = "line one\n☃ snowman\n" + "x".repeat(1000);
    const bytes = Buffer.from(body);
    client.send({ type: "file_upload_begin", id: "up1", name: "notes.txt", size: bytes.length } as never);
    for (let at = 0; at < bytes.length; at += 500) {
      client.send({ type: "file_upload_chunk", id: "up1", data: b64(bytes.subarray(at, at + 500)) } as never);
    }
    const done = (await client.type("file_upload_done")) as { id: string; path: string; name: string };
    assert.equal(done.id, "up1");
    assert.equal(done.name, "notes.txt");
    // The daemon is another process, so its random staging root is not this
    // process's `stagingDir()`; the shape is what is pinned: a per-daemon
    // mkdtemp root, the session dir beneath it (audit 2026-08-26).
    const sessionDir = path.dirname(done.path);
    assert.equal(path.basename(sessionDir), sessionId, `staged outside staging: ${done.path}`);
    assert.match(path.basename(path.dirname(sessionDir)), /^mirafold-uploads-/, `staged outside staging: ${done.path}`);
    assert.equal(fs.statSync(sessionDir).mode & 0o077, 0, "the session dir is owner-only");
    assert.equal(fs.readFileSync(done.path, "utf8"), body);

    // The same connection refuses an over-cap declaration with a typed
    // reply and stays healthy for a follow-up upload.
    client.send({
      type: "file_upload_begin",
      id: "up2",
      name: "huge.bin",
      size: FILE_UPLOAD_MAX_BYTES + 1,
    } as never);
    const refused = (await client.type("file_upload_error")) as { id: string };
    assert.equal(refused.id, "up2");

    client.send({ type: "file_upload_begin", id: "up3", name: "second.txt", size: 2 } as never);
    client.send({ type: "file_upload_chunk", id: "up3", data: b64("ok") } as never);
    const done3 = (await client.type("file_upload_done")) as { id: string; path: string };
    assert.equal(done3.id, "up3");
    assert.equal(fs.readFileSync(done3.path, "utf8"), "ok");
    staged = path.dirname(done3.path);
  } finally {
    // The daemon's staging root is its own (a separate process mints its own
    // mkdtemp) — clean what a reply named, never a dir computed here.
    if (staged) fs.rmSync(staged, { recursive: true, force: true });
    client.close();
  }
});

test("FD.1: overflow past the declared size dies with a typed error, file never staged", async () => {
  const { client } = await createSession(d.port);
  let staged: string | undefined;
  try {
    client.send({ type: "file_upload_begin", id: "ov", name: "small.txt", size: 3 } as never);
    client.send({ type: "file_upload_chunk", id: "ov", data: b64("way too many bytes") } as never);
    const err = (await client.type("file_upload_error")) as { id: string };
    assert.equal(err.id, "ov");
    // The daemon's session dir is only knowable from a reply (test-audit
    // 2026-08-26: `stagingDir()` called HERE named this process's own root, a
    // directory that never existed, so the old assertion could not fail). A
    // sibling upload names it; the dead one must not be beside it.
    client.send({ type: "file_upload_begin", id: "sib", name: "sibling.txt", size: 2 } as never);
    client.send({ type: "file_upload_chunk", id: "sib", data: b64("ok") } as never);
    const done = (await client.type("file_upload_done")) as { id: string; path: string };
    staged = path.dirname(done.path);
    assert.deepEqual(fs.readdirSync(staged), ["sibling.txt"], "nothing may be staged from a dead upload");
  } finally {
    if (staged) fs.rmSync(staged, { recursive: true, force: true });
    client.close();
  }
});
