import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changeCountLabel,
  changeItems,
  changeSetIncomplete,
  changeStatus,
  chooseChange,
  repoLabel,
} from "./changes";

const repos = [
  {
    root: "zeta",
    entries: [{ path: "zeta/b.ts", status: "D" }],
  },
  {
    root: "alpha",
    entries: [
      { path: "alpha/z.ts", status: "U" },
      { path: "alpha/a.ts", status: "M" },
    ],
  },
];

test("changeItems: repositories and files are deterministic, with display paths scoped to their group", () => {
  assert.deepEqual(changeItems(repos), [
    { repoRoot: "alpha", path: "alpha/a.ts", displayPath: "a.ts", status: "M" },
    { repoRoot: "alpha", path: "alpha/z.ts", displayPath: "z.ts", status: "U" },
    { repoRoot: "zeta", path: "zeta/b.ts", displayPath: "b.ts", status: "D" },
  ]);
});

test("chooseChange: a still-valid selection survives refresh; a vanished one falls to the first", () => {
  const items = changeItems(repos);
  assert.equal(chooseChange(items, "alpha/z.ts")?.path, "alpha/z.ts");
  assert.equal(chooseChange(items, "gone.ts")?.path, "alpha/a.ts");
  assert.equal(chooseChange([], "alpha/z.ts"), undefined);
});

test("changeCountLabel: exact sets say changes; truncated/error sets say only what is visible", () => {
  assert.equal(changeCountLabel(repos, false), "3 changes");
  assert.equal(changeCountLabel([{ root: "", entries: [{ path: "a", status: "A" }] }], false), "1 change");
  assert.equal(changeCountLabel(repos, true), "3 visible");
  const errored = [{ root: "repo", entries: [], error: "git failed" }];
  assert.equal(changeCountLabel(errored, false), "0 visible");
  assert.equal(changeSetIncomplete(errored, false), true);
});

test("changeStatus: only the protocol vocabulary earns a specific label and CSS code", () => {
  assert.deepEqual(changeStatus("M"), { code: "M", label: "Modified" });
  assert.deepEqual(changeStatus("A"), { code: "A", label: "Added" });
  assert.deepEqual(changeStatus("D"), { code: "D", label: "Deleted" });
  assert.deepEqual(changeStatus("U"), { code: "U", label: "Untracked" });
  assert.deepEqual(changeStatus("hostile-class"), { code: "?", label: "Changed" });
});

test("repoLabel: a root repo uses the workspace leaf across POSIX and Windows labels", () => {
  assert.equal(repoLabel("packages/tool", "~/Projects/mirafold"), "packages/tool");
  assert.equal(repoLabel("", "~/Projects/mirafold/"), "mirafold");
  assert.equal(repoLabel("", "C:\\Users\\Kyle\\project\\"), "project");
  assert.equal(repoLabel("", undefined), "Repository");
});
