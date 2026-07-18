import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { listCodexModels } from "./codex-model-list";

// V.2: the app-server model/list exchange against a stub binary (the
// MIRAFOLD_CODEX_BIN seam — the bangShell/MIRAFOLD_GEMINI_BIN pattern):
// initialize handshake, catalog parse, hidden filtering, and the fail paths.

const tmp = mkdtempSync(path.join(os.tmpdir(), "codex-model-list-"));

/** Write an executable node script that speaks newline-delimited JSON-RPC. */
function stubBin(name: string, body: string): string {
  const file = path.join(tmp, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

const HAPPY_BIN = stubBin(
  "codex-happy",
  `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: "stub" } }) + "\\n");
  } else if (msg.method === "model/list") {
    process.stdout.write(
      JSON.stringify({
        id: msg.id,
        result: {
          data: [
            { id: "m-a", displayName: "Model A", description: "first", hidden: false, isDefault: true },
            { id: "m-hidden", displayName: "Hidden", description: "nope", hidden: true, isDefault: false },
            { id: "m-b", displayName: "Model B", description: "second", hidden: false, isDefault: false },
          ],
        },
      }) + "\\n",
    );
  }
});
`,
);

test("happy exchange: handshake, parse, hidden models filtered", async () => {
  process.env.MIRAFOLD_CODEX_BIN = HAPPY_BIN;
  try {
    const models = await listCodexModels(5_000);
    assert.deepEqual(models, [
      { id: "m-a", displayName: "Model A", description: "first", isDefault: true },
      { id: "m-b", displayName: "Model B", description: "second", isDefault: false },
    ]);
  } finally {
    delete process.env.MIRAFOLD_CODEX_BIN;
  }
});

test("binary that exits without answering rejects (never a made-up list)", async () => {
  process.env.MIRAFOLD_CODEX_BIN = stubBin("codex-dead", "process.exit(1);\n");
  try {
    await assert.rejects(listCodexModels(5_000), /exited before answering/);
  } finally {
    delete process.env.MIRAFOLD_CODEX_BIN;
  }
});

test("silent binary times out", async () => {
  process.env.MIRAFOLD_CODEX_BIN = stubBin("codex-mute", "setInterval(() => {}, 1000);\n");
  try {
    await assert.rejects(listCodexModels(300), /timed out/);
  } finally {
    delete process.env.MIRAFOLD_CODEX_BIN;
  }
});
