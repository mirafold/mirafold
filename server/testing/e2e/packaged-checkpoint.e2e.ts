import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachSession,
  createSession,
  startDaemon,
  type Daemon,
  type TestClient,
} from "../itest-harness";

// Phase CPERF, Tier 3: the same five-session saving and recovery the Tier-2
// suite proves against TypeScript source, exercised against the PACKAGED
// daemon (`dist-server/index.js` serving the built web bundle) — the exact
// artifact npm users run — under the harness's isolation and credential
// scrub. Needs a fresh `yarn build` (test:e2e does it).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SESSIONS = 5;

test("packaged daemon: five sessions checkpoint under load, and a restart recovers each one", async () => {
  assert.ok(existsSync(path.join(ROOT, "dist-server", "index.js")), "dist-server missing — run `yarn build` first");
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-packaged-checkpoint-"));
  let first: Daemon | undefined;
  let second: Daemon | undefined;
  const clients: TestClient[] = [];
  try {
    first = await startDaemon({ MIRAFOLD_SESSION_DIR: sessionDir }, { built: true });
    const shell = await fetch(`http://127.0.0.1:${first.port}/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /<div id="root">/, "the built web bundle is served");

    // Five sessions, each streaming a long scripted turn at once.
    const created = await Promise.all(
      Array.from({ length: SESSIONS }, () => createSession(first!.port, "codex")),
    );
    for (const { client } of created) clients.push(client);
    for (const [i, { client }] of created.entries()) {
      client.send({ type: "prompt", text: `produce a huge output #${i + 1}` });
    }
    await Promise.all(created.map(({ client }) => client.type("turn_end", 40_000)));

    const ids = created.map((c) => c.sessionId);
    assert.equal(new Set(ids).size, SESSIONS);
    for (const id of ids) {
      const record = JSON.parse(readFileSync(path.join(sessionDir, `${id}.json`), "utf8")) as {
        id: string;
        buffer: { type: string; text?: string }[];
      };
      assert.equal(record.id, id);
      assert.equal(record.buffer.at(-1)?.type, "turn_end", `${id}: the boundary record is complete`);
      assert.ok(record.buffer.some((m) => m.type === "user_prompt"), `${id}: the prompt is in the record`);
    }
    for (const client of clients.splice(0)) client.close();
    await first.stop();
    first = undefined;
    assert.deepEqual(readdirSync(sessionDir).filter((n) => n.endsWith(".tmp")), [], "no temp file survives the stop");

    // A restart reopens every id with its transcript; switching between two
    // recovered sessions from separate viewports works.
    second = await startDaemon({ MIRAFOLD_SESSION_DIR: sessionDir }, { built: true });
    for (const [i, id] of ids.entries()) {
      const attached = await attachSession(second.port, id);
      clients.push(attached.client);
      assert.equal(attached.created.sessionId, id);
      assert.equal(attached.created.fallback, undefined, `${id}: recovered, not a blank fallback`);
      const prompt = (await attached.client.type("user_prompt", 20_000)) as { text: string };
      assert.equal(prompt.text, `produce a huge output #${i + 1}`);
      await attached.client.type("turn_end", 20_000);
    }
    // A recovered session still takes a prompt and answers.
    const live = clients[0];
    live.send({ type: "prompt", text: "service health" });
    await live.type("turn_end", 30_000);
  } finally {
    for (const client of clients) client.close();
    if (first) await first.stop();
    if (second) await second.stop();
  }
});
