import { test } from "node:test";
import assert from "node:assert/strict";
import { capOutput, toolDetail } from "./types";

// The default cap is 64 KB (TOOL_OUTPUT_CAP_BYTES), read at module load.
const CAP = 64_000;

test("capOutput leaves sub-cap text untouched", () => {
  const r = capOutput("hello");
  assert.equal(r.text, "hello");
  assert.equal(r.truncatedBytes, undefined);
});

test("capOutput leaves exactly-at-cap text untouched", () => {
  const r = capOutput("a".repeat(CAP));
  assert.equal(r.truncatedBytes, undefined);
  assert.equal(Buffer.byteLength(r.text, "utf8"), CAP);
});

test("capOutput truncates over-cap ASCII and reports the elided byte count", () => {
  const total = 100_000;
  const r = capOutput("a".repeat(total));
  assert.equal(Buffer.byteLength(r.text, "utf8"), CAP);
  assert.equal(r.truncatedBytes, total - CAP);
});

test("capOutput cuts on a byte boundary, replacing a straddling multibyte char", () => {
  // 63999 ASCII bytes + a 3-byte '€': the cap at byte 64000 falls inside '€'.
  const input = "a".repeat(CAP - 1) + "€";
  const r = capOutput(input);
  // The partial lead byte decodes to U+FFFD rather than crashing.
  assert.equal(r.text.at(-1), "�");
  assert.equal(r.truncatedBytes, Buffer.byteLength(input, "utf8") - CAP); // = 2
});

test("toolDetail returns the first present salient key in precedence order", () => {
  assert.equal(toolDetail({ command: "ls", file_path: "a" }), "ls");
  assert.equal(toolDetail({ file_path: "a", pattern: "p" }), "a");
  assert.equal(toolDetail({ command: "", file_path: "a" }), "a"); // empty string skipped
});

test("toolDetail falls back to sliced JSON, and undefined for empty/non-objects", () => {
  assert.equal(toolDetail({}), undefined);
  assert.equal(toolDetail(null), undefined);
  assert.equal(toolDetail("nope"), undefined);
  const long = toolDetail({ foo: "x".repeat(300) });
  assert.ok(long && long.length <= 160 && long.startsWith("{"));
});
