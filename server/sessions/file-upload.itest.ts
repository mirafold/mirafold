import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDaemon, createSession, type Daemon } from "../testing/itest-harness";
import { stagingDir, FILE_UPLOAD_MAX_BYTES } from "./upload-handlers";

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
    assert.ok(done.path.startsWith(stagingDir(sessionId)), `staged outside staging: ${done.path}`);
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
  } finally {
    fs.rmSync(stagingDir(sessionId), { recursive: true, force: true });
    client.close();
  }
});

test("FD.1: overflow past the declared size dies with a typed error, file never staged", async () => {
  const { client, sessionId } = await createSession(d.port);
  try {
    client.send({ type: "file_upload_begin", id: "ov", name: "small.txt", size: 3 } as never);
    client.send({ type: "file_upload_chunk", id: "ov", data: b64("way too many bytes") } as never);
    const err = (await client.type("file_upload_error")) as { id: string };
    assert.equal(err.id, "ov");
    const dir = stagingDir(sessionId);
    const staged = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.deepEqual(staged, [], "nothing may be staged from a dead upload");
  } finally {
    fs.rmSync(stagingDir(sessionId), { recursive: true, force: true });
    client.close();
  }
});
