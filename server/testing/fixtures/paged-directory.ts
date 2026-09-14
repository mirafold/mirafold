import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Deterministic filesystem order for the real daemon: a full raw page of
 * files, then a real directory whose child can be opened in the browser.
 * Only opendir for this temporary root is replaced; protocol, pagination,
 * jail, registry, and browser behavior all run through production code. */
export function pagedDirectoryFixture() {
  const base = mkdtempSync(path.join(tmpdir(), "mirafold-paged-directory-"));
  const root = path.join(base, "workspace");
  mkdirSync(path.join(root, "late-directory"), { recursive: true });
  writeFileSync(path.join(root, "late-directory", "reachable.txt"), "Reached the later directory.\n");
  const preload = path.join(base, "directory-order.cjs");
  writeFileSync(preload, `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const original = fs.opendirSync;
fs.opendirSync = function (dir, ...args) {
  if (String(dir) !== ${JSON.stringify(root)}) return original.call(this, dir, ...args);
  let position = 0;
  let closed = false;
  return {
    readSync() {
      if (closed) throw new Error('fixture directory is closed');
      if (position > 10000) return null;
      const index = position++;
      return {
        name: index === 10000 ? 'late-directory' : 'file-' + String(index).padStart(5, '0') + '.txt',
        isDirectory: () => index === 10000,
        isSymbolicLink: () => false,
      };
    },
    closeSync() { closed = true; },
  };
};
syncBuiltinESMExports();
`);
  return {
    root,
    env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${JSON.stringify(preload)}`].filter(Boolean).join(" ") },
    close: () => rmSync(base, { recursive: true, force: true }),
  };
}
