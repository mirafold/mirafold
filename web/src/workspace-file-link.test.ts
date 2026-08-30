import { test } from "node:test";
import assert from "node:assert/strict";
import { workspacePathFromHref } from "./workspace-file-link";

test("workspace file links resolve absolute and relative targets under the session root", () => {
  const root = "/home/kyle/Projects/a project";
  assert.equal(
    workspacePathFromHref("/home/kyle/Projects/a%20project/src/app.ts", root),
    "src/app.ts",
  );
  assert.equal(workspacePathFromHref("docs/guide%20one.md", root), "docs/guide one.md");
  assert.equal(workspacePathFromHref("./README.md", root), "README.md");
});

test("workspace file links discard standard line and fragment locations", () => {
  const root = "/work/project";
  assert.equal(workspacePathFromHref("/work/project/src/app.ts:42:7", root), "src/app.ts");
  assert.equal(workspacePathFromHref("README.md#L12-L18", root), "README.md");
  assert.equal(workspacePathFromHref("docs/guide.md#install", root), "docs/guide.md");
});

test("workspace file links reject URLs, outside paths, traversal, queries, and malformed escapes", () => {
  const root = "/work/project";
  for (const href of [
    "https://example.test/file.ts",
    "exp://127.0.0.1:8081",
    "mailto:kyle@example.test",
    "//example.test/file.ts",
    "/work/project-two/file.ts",
    "/etc/passwd",
    "../outside.ts",
    "src/../../outside.ts",
    "src/app.ts?raw=1",
    "src/%ZZ.ts",
  ]) {
    assert.equal(workspacePathFromHref(href, root), null, href);
  }
});

test("workspace file links support Windows drive roots without weakening containment", () => {
  const root = "C:\\Users\\Kyle\\project";
  assert.equal(workspacePathFromHref("C:/Users/Kyle/project/src/app.ts:9", root), "src/app.ts");
  assert.equal(workspacePathFromHref("/C:/Users/Kyle/project/README.md", root), "README.md");
  assert.equal(workspacePathFromHref("C:/Users/Kyle/other/app.ts", root), null);
});
