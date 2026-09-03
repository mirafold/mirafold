import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  attachSession,
  createSession,
  startDaemon,
  type Daemon,
  type TestClient,
} from "../../testing/itest-harness";

test("a daemon restart reopens the same session id and transcript instead of creating a blank fallback", async () => {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-recovery-itest-"));
  let first: Daemon | undefined;
  let second: Daemon | undefined;
  let firstClient: TestClient | undefined;
  let secondClient: TestClient | undefined;
  try {
    first = await startDaemon({ MIRAFOLD_SESSION_DIR: sessionDir });
    const created = await createSession(first.port, "codex");
    firstClient = created.client;
    firstClient.send({ type: "prompt", text: "health" });
    await firstClient.type("turn_end", 20_000);
    firstClient.close();
    await first.stop();
    first = undefined;

    second = await startDaemon({ MIRAFOLD_SESSION_DIR: sessionDir });
    const attached = await attachSession(second.port, created.sessionId);
    secondClient = attached.client;
    assert.equal(attached.created.sessionId, created.sessionId);
    assert.equal(attached.created.fallback, undefined);

    const prompt = await secondClient.type("user_prompt");
    assert.equal((prompt as { text: string }).text, "health");
    const answer = await secondClient.type("text_delta", 20_000);
    assert.equal(answer.replay, true);
    await secondClient.type("turn_end");

    secondClient.send({ type: "end_session", sessionId: created.sessionId });
    await secondClient.type("session_ended");
  } finally {
    firstClient?.close();
    secondClient?.close();
    if (first) await first.stop();
    if (second) await second.stop();
  }
});
