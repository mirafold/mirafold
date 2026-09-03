import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { listGeminiModels } from "./gemini-model-list";

// V.2 (Gemini half): the ACP initialize → session/new exchange against a stub
// binary (the MIRAFOLD_GEMINI_BIN seam): catalog parse, error response, and
// the fail paths — the codex-model-list.test.ts pattern.

const tmp = mkdtempSync(path.join(os.tmpdir(), "gemini-model-list-"));

/** Write an executable node script that speaks newline-delimited JSON-RPC. */
function stubBin(name: string, body: string): string {
  const file = path.join(tmp, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

const HAPPY_BIN = stubBin(
  "gemini-happy",
  `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "s1",
          models: {
            availableModels: [
              null,
              { modelId: "auto", name: "Auto", description: "Let Gemini CLI decide" },
              { modelId: "gemini-x-pro", name: "gemini-x-pro" },
            ],
            currentModelId: "auto",
          },
        },
      }) + "\\n",
    );
  }
});
`,
);

test("happy exchange: handshake, catalog + currentModelId parsed", async () => {
  process.env.MIRAFOLD_GEMINI_BIN = HAPPY_BIN;
  try {
    const catalog = await listGeminiModels(tmp, 5_000);
    assert.deepEqual(catalog, {
      models: [
        { id: "auto", displayName: "Auto", description: "Let Gemini CLI decide" },
        { id: "gemini-x-pro", displayName: "gemini-x-pro", description: "" },
      ],
      currentModelId: "auto",
    });
  } finally {
    delete process.env.MIRAFOLD_GEMINI_BIN;
  }
});

test("a JSON-RPC error response rejects with its message", async () => {
  process.env.MIRAFOLD_GEMINI_BIN = stubBin(
    "gemini-err",
    `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "Authentication required." } }) + "\\n");
});
`,
  );
  try {
    await assert.rejects(listGeminiModels(tmp, 5_000), /Authentication required/);
  } finally {
    delete process.env.MIRAFOLD_GEMINI_BIN;
  }
});

test("binary that exits without answering rejects (never a made-up list)", async () => {
  process.env.MIRAFOLD_GEMINI_BIN = stubBin("gemini-dead", "process.exit(1);\n");
  try {
    await assert.rejects(listGeminiModels(tmp, 5_000), /exited before answering/);
  } finally {
    delete process.env.MIRAFOLD_GEMINI_BIN;
  }
});

test("silent binary times out", async () => {
  process.env.MIRAFOLD_GEMINI_BIN = stubBin("gemini-mute", "setInterval(() => {}, 1000);\n");
  try {
    await assert.rejects(listGeminiModels(tmp, 300), /timed out/);
  } finally {
    delete process.env.MIRAFOLD_GEMINI_BIN;
  }
});
