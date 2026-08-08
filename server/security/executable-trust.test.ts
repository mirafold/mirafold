import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isProjectExecutablePath, locateTrustedExecutable } from "./executable-trust";

function executable(file: string): void {
  writeFileSync(file, "");
  if (process.platform !== "win32") chmodSync(file, 0o755);
}

test("trusted lookup skips npm bins and keeps the next global executable", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-exec-root-"));
  const npmBin = path.join(root, "node_modules", ".bin");
  const globalBin = mkdtempSync(path.join(os.tmpdir(), "mirafold-exec-global-"));
  const name = `mirafold-helper-${process.pid}`;
  mkdirSync(npmBin, { recursive: true });
  executable(path.join(npmBin, name));
  const trusted = path.join(globalBin, name);
  executable(trusted);
  try {
    assert.equal(
      locateTrustedExecutable(name, {
        env: { PATH: `${npmBin}${path.delimiter}${globalBin}` },
        launchDir: root,
      }),
      realpathSync.native(trusted),
    );
    assert.equal(
      locateTrustedExecutable(name, { env: { PATH: npmBin }, launchDir: root }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(globalBin, { recursive: true, force: true });
  }
});

test("trusted lookup refuses project files and relative PATH entries", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-exec-project-"));
  const bin = path.join(root, "tools");
  const name = `mirafold-project-helper-${process.pid}`;
  mkdirSync(bin);
  const file = path.join(bin, name);
  executable(file);
  try {
    assert.equal(isProjectExecutablePath(file, root), true);
    assert.equal(locateTrustedExecutable(file, { launchDir: root }), undefined);
    assert.equal(
      locateTrustedExecutable(name, { env: { PATH: "tools" }, launchDir: root }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "trusted lookup resolves symlinks before applying the project boundary",
  { skip: process.platform === "win32" && "file symlinks require extra privileges on Windows" },
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-exec-link-root-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "mirafold-exec-link-bin-"));
    const target = path.join(root, "helper");
    const link = path.join(outside, "helper");
    executable(target);
    symlinkSync(target, link);
    try {
      assert.equal(
        locateTrustedExecutable("helper", {
          env: { PATH: outside },
          launchDir: root,
        }),
        undefined,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  },
);
