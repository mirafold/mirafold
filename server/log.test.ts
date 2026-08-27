import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrub, scrubSelectedEndpoint } from "./log";

// The flight-recorder file is what "attach your log" points at, so it must
// stay safe to paste publicly. Our own secrets never reach the logger, but
// adapters forward third-party engine stderr verbatim — the realistic leak
// (2026-07-27 audit).

test("scrub redacts a credential carried in a query string", () => {
  // The concrete Gemini case: its REST API authenticates with ?key=, and a
  // failing CLI run echoes the request URL into the stderr tail we log.
  const line =
    "gemini exited 1: fetch failed https://generativelanguage.googleapis.com/v1/models?key=AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q";
  const out = scrub(line);
  assert.ok(!out.includes("AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q"), out);
  assert.match(out, /key=\[redacted\]/);
  assert.match(out, /gemini exited 1/); // the diagnostic survives
});

test("UX.8: scrub treats configured URL userinfo, arbitrary signed queries, and fragments as sensitive", () => {
  const raw =
    "failed https://alice:password@example.test/v1?sig=topsecret&region=west#local-secret";
  const out = scrub(raw);
  assert.equal(
    out,
    "failed https://[redacted]@example.test/v1?sig=[redacted]&region=[redacted]#[redacted]",
  );
  assert.doesNotMatch(out, /alice|password|topsecret|local-secret/);
});

test("UX.8: selected-endpoint scrubbing also removes secret-bearing URL paths", () => {
  const endpoint = "https://tenant.example/private/token-path";
  const out = scrubSelectedEndpoint(`request ${endpoint}/messages failed`, endpoint);
  assert.equal(out, "request [selected endpoint]/messages failed");
  assert.doesNotMatch(out, /tenant|private|token-path/);
});

test("scrub redacts known provider key shapes anywhere in the line", () => {
  assert.match(scrub("auth error for sk-abcdefghijklmnopqrstuvwx"), /\[redacted-key\]/);
  assert.match(scrub("key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF failed"), /\[redacted-key\]/);
  assert.match(scrub("AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q rejected"), /\[redacted-key\]/);
  assert.match(scrub("using ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), /\[redacted-key\]/);
  assert.equal(scrub("sk-abcdefghijklmnopqrstuvwx").includes("abcdefghij"), false);
});

test("AUDIT: scrub redacts AWS and Google Vertex credential families", () => {
  // The Claude engine supports Bedrock/Vertex and the adapter passes
  // process.env through; a session echoing these into stderr must not land
  // in the flight-recorder file users attach to bug reports (audit 2026-08-13).
  assert.match(scrub("AKIAIOSFODNN7EXAMPLE denied"), /\[redacted-key\]/);
  assert.match(scrub("ASIAIOSFODNN7EXAMPLE (session) denied"), /\[redacted-key\]/);
  assert.match(scrub("token ya29.a0AfB_longlonglonglongvalue rejected"), /\[redacted-key\]/);
  assert.equal(scrub("AKIAIOSFODNN7EXAMPLE").includes("IOSFODNN7"), false);
  assert.equal(scrub("ya29.a0AfB_longlonglonglongvalue").includes("longlong"), false);
});

test("scrub redacts an Authorization header echoed into an error", () => {
  const out = scrub("401 from upstream (Authorization: Bearer ya29.A0ARrdaM-secret-value)");
  assert.ok(!out.includes("ya29.A0ARrdaM-secret-value"), out);
  assert.match(out, /Bearer \[redacted\]/);
});

test("the scrubber is actually WIRED to both sinks, not just exported", () => {
  // A scrubber nobody calls is the same as no scrubber. log.ts resolves its
  // file path at import time, so this rides a child process with the sink
  // pointed at a temp file — the real emit() path, console and file both.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirafold-log-"));
  const logPath = path.join(dir, "probe.log");
  // A log left behind by an older build was world-readable: the sink re-modes
  // it on first use (the pre-existing-file branch — cold review 2026-08-26).
  fs.writeFileSync(logPath, "older build's line\n", { mode: 0o644 });
  const KEY = "AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q";
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  try {
    const stdio = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `import { createLogger } from ${JSON.stringify(path.join(serverDir, "log.ts"))};` +
          `createLogger("probe").error("gemini exited 1: GET https://x/v1?key=${KEY}");` +
          `createLogger("probe").file("twin: ?key=${KEY}");`,
      ],
      { env: { ...process.env, MIRAFOLD_LOG_FILE: logPath }, encoding: "utf8", stdio: "pipe" },
    );
    const onDisk = fs.readFileSync(logPath, "utf8");
    // The file and its directory are owner-only (audit 2026-08-26); pinned
    // here because this is the one test that exercises the real sink.
    assert.equal(fs.statSync(logPath).mode & 0o077, 0, "the log file is 0600");
    assert.ok(!onDisk.includes(KEY), `key reached the log FILE:\n${onDisk}`);
    assert.ok(!stdio.includes(KEY), `key reached the console:\n${stdio}`);
    assert.equal((onDisk.match(/\[redacted\]/g) ?? []).length, 2); // error() and file()
    assert.match(onDisk, /gemini exited 1/); // still a useful diagnostic
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scrub leaves ordinary log text untouched", () => {
  // Shaped patterns, not entropy guessing — normal lines must survive intact.
  for (const line of [
    "server on http://127.0.0.1:3000/ (ws at /ws; auth token elided)",
    "session abc-123 created in /home/user/projects/thing",
    "GET /assets/index-4f8a2b1c.js 200",
    "a ! command is already running (stop it first)",
    "no diff available for this entry",
    "monkey=business and key-value pairs in prose",
  ]) {
    assert.equal(scrub(line), line, line);
  }
});

// AUDIT 2026-08-26: engine stderr and client-reported errors are logged
// verbatim; a newline forged a whole second log line and an ESC sequence
// retitled the terminal. One record is one line, with no control bytes.
test("AUDIT: a log line cannot carry a forged second line or a terminal control sequence", async () => {
  const { sanitizeLogLine } = await import("./log");
  const hostile = "engine said hi\n[2026-08-26T00:00:00.000Z] [auth] token accepted FORGED\r\n\u001b]0;retitled\u0007\u0000tail";
  const out = sanitizeLogLine(hostile);
  assert.ok(!out.includes("\n") && !out.includes("\r"), out);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(out), "no control bytes survive");
  assert.match(out, /engine said hi⏎\[2026/, "the newline is shown, not honored");
  assert.match(out, /retitledtail$/);
});
