import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prepareEditInput, editPreview } from "./edit-input";
import { ToolBlock } from "./ToolBlock";

test("preview finds changed lines after long context and budgets EOF markers, files and rows", () => {
  const changes = Array.from({ length: 5 }, (_, i) => ({ path: `file-${i}`, kind: "update", diff: "@@ -1 +1 @@\n" + " context\n".repeat(40) + "-old\n+new\n\\ No newline at end of file\n" }));
  const input = { changes };
  const prepared = prepareEditInput("apply_patch", input)!;
  const preview = editPreview(prepared);
  assert.equal(preview.files.length, 3);
  assert.equal(preview.omitted, true);
  assert.ok(preview.files.flatMap((f) => f.lines).reduce((n, l) => n + 1 + Number(!!l.noNewline), 0) <= 12);
  assert.equal(preview.files[0].lines[0].text, "old");
  assert.equal(prepared.files.length, 5);
  assert.equal(input.changes, changes, "preparation never mutates retained input");
});

test("add, delete, path-only move and equal inputs retain their meaning", () => {
  const prepared = prepareEditInput("apply_patch", { changes: [
    { kind: "add", path: "new", diff: "created\n" },
    { kind: "delete", path: "gone", diff: "deleted" },
    { kind: "update", path: "old", movePath: "renamed", diff: "" },
  ] })!;
  const preview = editPreview(prepared);
  assert.equal(preview.files[0].lines[0].sign, "+");
  assert.deepEqual(preview.files[1].lines[0], { sign: "-", text: "deleted", noNewline: true });
  assert.match(preview.files[2].label, /Moved old → renamed/);
  assert.deepEqual(editPreview(prepareEditInput("Edit", { old_string: "same", new_string: "same" })!).files, []);
  assert.equal(editPreview(prepareEditInput("Edit", { old_string: "same", new_string: "same\n" })!).files[0].lines.length, 2);
});

test("an EOF marker that exceeds the remaining budget omits that preview, never claims no diff", () => {
  const prepared = prepareEditInput("apply_patch", { changes: [
    { path: "first", kind: "add", diff: "row\n".repeat(11) },
    { path: "deleted", kind: "delete", diff: "important" },
  ] })!;
  const preview = editPreview(prepared);
  assert.equal(preview.files.length, 1);
  assert.equal(preview.omitted, true);
  assert.equal(prepared.files[1].lines[0].text, "important");
});

test("expanded pending and failed edits label input without claiming completion", () => {
  for (const failed of [false, true]) for (const name of ["Edit", "Write"]) {
    const html = renderToStaticMarkup(createElement(ToolBlock, {
      toggleKey: "tool:e", name, expanded: true, onToggle() {},
      input: { file_path: "failed.ts", old_string: "old", new_string: "new", content: "write" },
      ...(failed ? { output: "failed", isError: true } : {}),
    }));
    assert.match(html, /(?:Update|Write) input · failed.ts/);
    assert.doesNotMatch(html, /Updated failed.ts|Written content/);
  }
});

test("malformed and aggregate oversized inputs decline preparation but retain expansion", () => {
  for (const input of [
    { edits: [null, { old_string: "a", new_string: "b" }] },
    { edits: Array.from({ length: 201 }, () => ({ old_string: "a", new_string: "b" })) },
    { edits: Array.from({ length: 3 }, () => ({ old_string: "a".repeat(40_000), new_string: "b".repeat(40_000) })) },
  ]) {
    const prepared = prepareEditInput("MultiEdit", input)!;
    assert.ok(prepared.unavailable);
    assert.deepEqual(prepared.files, []);
  }
  const content = "x".repeat(200_001) + "retained-end";
  const html = renderToStaticMarkup(createElement(ToolBlock, { name: "Write", input: { content }, toggleKey: "tool:w", expanded: true, onToggle() {} }));
  assert.ok(html.includes("retained-end"));
});

test("only an untouched successful call previews edits; writes show content without diff signs", () => {
  const base = { name: "Edit", input: { file_path: "a.ts", old_string: "old\n", new_string: "new\n" }, output: "ok", toggleKey: "tool:e", expanded: false, previewDefault: true, onToggle() {} };
  const render = (overrides: Partial<typeof base> & { isError?: boolean; exitCode?: number }) => renderToStaticMarkup(createElement(ToolBlock, { ...base, ...overrides }));
  assert.match(render({}), /tool-edit-preview[\s\S]*diff-del[\s\S]*diff-add/);
  for (const override of [{ output: undefined }, { isError: true }, { exitCode: 1 }, { previewDefault: false }, { expanded: true }]) assert.doesNotMatch(render(override), /tool-edit-preview/);
  const write = renderToStaticMarkup(createElement(ToolBlock, { ...base, name: "Write", input: { file_path: "a.ts", content: "written\n" } }));
  assert.match(write, /Written content/);
  assert.doesNotMatch(write, /diff-add|diff-del|tool-change/);
});
