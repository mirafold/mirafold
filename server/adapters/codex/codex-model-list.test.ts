import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { listCodexModels } from "./codex-model-list";
import { configArgs } from "./codex-model-list";
import { listCodexSkills } from "./codex-skills-list";
import { jsonRpcOneShot } from "../jsonrpc-oneshot";

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

// Answers with its own argv as the catalog — so a test can read exactly what
// reached the spawn.
const ARGV_BIN = stubBin(
  "codex-argv",
  `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
  } else if (msg.method === "model/list") {
    const data = process.argv.slice(2).map((a) => ({ id: a, hidden: false, isDefault: false }));
    process.stdout.write(JSON.stringify({ id: msg.id, result: { data } }) + "\\n");
  }
});
`,
);

test("config overrides ride as -c key=value, nested tables flattened (2026-07-20)", async () => {
  // The pin that keeps a catalog question on the asker's own provider.
  const models = await listCodexModels(5_000, ARGV_BIN, {
    model_provider: "openai",
    model_providers: { mirafold_local: { base_url: "http://127.0.0.1:11434/v1" } },
  });
  assert.deepEqual(
    models.map((m) => m.id),
    [
      "app-server",
      "-c",
      'model_provider="openai"',
      "-c",
      'model_providers.mirafold_local.base_url="http://127.0.0.1:11434/v1"',
    ],
  );
});

test("no config = no -c args (the unpinned call is unchanged)", async () => {
  const models = await listCodexModels(5_000, ARGV_BIN);
  assert.deepEqual(models.map((m) => m.id), ["app-server"]);
});

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

test("skills/list returns enabled $ completions for the requested workspace", async () => {
  const bin = stubBin(
    "codex-skills",
    `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
  } else if (msg.method === "skills/list") {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { data: [{ cwd: msg.params.cwds[0], errors: [], skills: [
        { name: "next", description: "continue the plan", enabled: true },
        { name: "hidden", description: "disabled", enabled: false },
      ] }] },
    }) + "\\n");
  }
});
`,
  );
  assert.deepEqual(await listCodexSkills(tmp, 5_000, bin), [
    { name: "next", description: "continue the plan" },
  ]);
});

test("skills/list skips malformed nested rows instead of throwing from the daemon stream", async () => {
  const bin = stubBin(
    "codex-skills-malformed",
    `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
  } else if (msg.method === "skills/list") {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { data: [null, { cwd: msg.params.cwds[0], skills: [
        null,
        { name: "next", description: "continue", enabled: true },
      ] }] },
    }) + "\\n");
  }
});
`,
  );
  assert.deepEqual(await listCodexSkills(tmp, 5_000, bin), [
    { name: "next", description: "continue" },
  ]);
});

test("an unexpected decoder throw rejects its one-shot lookup instead of escaping the stream callback", async () => {
  const bin = stubBin(
    "jsonrpc-decoder-throw",
    `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.once("line", () => process.stdout.write(JSON.stringify({ result: {} }) + "\\n"));
`,
  );
  await assert.rejects(
    jsonRpcOneShot({
      command: bin,
      args: [],
      timeoutMs: 5_000,
      label: "decoder probe",
      start: (send) => send({ probe: true }),
      onMessage: () => {
        throw new Error("decoder exploded");
      },
    }),
    /decoder exploded/,
  );
});

test("stray scalar/null stdout lines are skipped — never a daemon crash (2026-07-19 audit)", async () => {
  // A bare `null` line used to throw inside the stdout listener and take the
  // whole process down (reproduced live); the one-shot must shrug it off and
  // still complete the exchange.
  process.env.MIRAFOLD_CODEX_BIN = stubBin(
    "codex-noisy",
    `
process.stdout.write("null\\n42\\n\\"stray string\\"\\n");
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
        result: { data: [{ id: "m-a", displayName: "Model A", description: "", hidden: false, isDefault: true }] },
      }) + "\\n",
    );
  }
});
`,
  );
  try {
    const models = await listCodexModels(5_000);
    assert.deepEqual(models.map((m) => m.id), ["m-a"]);
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

test("configArgs: tables flatten to dotted keys, arrays stay whole (the binary rejects args.0=)", () => {
  assert.deepEqual(
    configArgs({ mcp_servers: { mirafold: { command: "/bin/node", args: ["/x/render-mcp.js", "--flag"], default_tools_approval_mode: "approve" } }, model_provider: "openai" }),
    [
      "-c", 'mcp_servers.mirafold.command="/bin/node"',
      "-c", 'mcp_servers.mirafold.args=["/x/render-mcp.js","--flag"]',
      "-c", 'mcp_servers.mirafold.default_tools_approval_mode="approve"',
      "-c", 'model_provider="openai"',
    ],
  );
});
