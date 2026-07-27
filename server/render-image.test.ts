import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMAGE_MAX_BYTES, resolveImageProps } from "./render-image";

// A real 1×1 PNG — the sniff must see genuine magic bytes.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let root: string;
let outside: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "mf-img-root-"));
  outside = mkdtempSync(path.join(tmpdir(), "mf-img-outside-"));
  mkdirSync(path.join(root, "shots"));
  writeFileSync(path.join(root, "shots", "ok.png"), PNG);
  writeFileSync(path.join(root, "impostor.png"), "just text wearing a png name");
  writeFileSync(path.join(root, "big.png"), Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES)]));
  writeFileSync(path.join(root, ".env"), PNG); // secret basename, image bytes
  writeFileSync(path.join(outside, "loot.png"), PNG);
  symlinkSync(path.join(outside, "loot.png"), path.join(root, "escape.png"));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("a real png resolves to a strictly-shaped data URI; agent fields survive, src/error are daemon-owned", () => {
  const out = resolveImageProps(root, {
    path: "shots/ok.png",
    alt: "the app",
    caption: "after the fix",
    // Hostile/pointless agent-supplied values for the daemon-owned pair:
    src: "javascript:alert(1)",
    error: "spoofed",
  });
  assert.equal(out["path"], "shots/ok.png");
  assert.equal(out["alt"], "the app");
  assert.equal(out["caption"], "after the fix");
  assert.equal(out["error"], undefined);
  assert.match(out["src"] as string, /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from((out["src"] as string).split(",")[1], "base64").equals(PNG), true);
});

test("containment: a symlink out of the workspace and a ../ path are both refused", () => {
  for (const p of ["escape.png", "../" + path.basename(outside) + "/loot.png"]) {
    const out = resolveImageProps(root, { path: p, alt: "x" });
    assert.equal(out["src"], undefined, p);
    assert.equal(out["error"], "missing, or outside the workspace", p);
  }
});

test("refusals: wrong bytes, oversize, secret basename, missing file, no path", () => {
  assert.equal(
    resolveImageProps(root, { path: "impostor.png", alt: "x" })["error"],
    "not a png/jpeg/gif/webp",
  );
  assert.match(String(resolveImageProps(root, { path: "big.png", alt: "x" })["error"]), /too large/);
  assert.equal(resolveImageProps(root, { path: ".env", alt: "x" })["error"], "not an image file");
  assert.equal(
    resolveImageProps(root, { path: "gone.png", alt: "x" })["error"],
    "missing, or outside the workspace",
  );
  assert.equal(resolveImageProps(root, { alt: "x" })["error"], "no path given");
});
