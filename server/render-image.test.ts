import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMAGE_MAX_BYTES, resolveImageProps } from "./render-image";
import { generativeUIMsg } from "./adapters/render-mcp-cmd";

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

// 2026-07-27 audit. Both render paths must run every image through the
// resolver — the agent's own `src` may never reach a viewport, or it would
// skip containment AND the byte cap. The workspace dir being a REQUIRED
// argument is what makes forgetting it a compile error rather than a silent
// hole; these pin the runtime half of that contract.
test("audit: the stdio adapters' path resolves images — an agent-authored src never survives", () => {
  const msg = generativeUIMsg(
    "render_image",
    { path: "shots/ok.png", alt: "x", src: "data:image/png;base64,QUFBQQ==" },
    "wire-id",
    root,
  );
  assert.ok(msg && msg.type === "render");
  const props = msg.props as Record<string, unknown>;
  // Resolved from the FILE, not from what the agent passed.
  assert.equal(
    Buffer.from((props["src"] as string).split(",")[1], "base64").equals(PNG),
    true,
    "the agent's src survived instead of the resolved file",
  );
});

test("audit: an escaping path yields no src on the adapters' path either", () => {
  const msg = generativeUIMsg(
    "render_image",
    { path: "escape.png", alt: "x", src: "data:image/png;base64,QUFBQQ==" },
    "wire-id",
    root,
  );
  const props = (msg as { props: Record<string, unknown> }).props;
  assert.equal(props["src"], undefined);
  assert.equal(props["error"], "missing, or outside the workspace");
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

// AUDIT 2026-08-26: the read opens the descriptor without following a link
// and judges THAT descriptor — a FIFO or directory swapped in under the name
// is refused without blocking the daemon, and a link is never followed.
test("AUDIT: a FIFO or a directory under an image name is refused promptly; a link is not followed", async () => {
  const { execFileSync } = await import("node:child_process");
  const fifo = path.join(root, "pipe.png");
  execFileSync("mkfifo", [fifo]);
  mkdirSync(path.join(root, "dir.png"));
  const t0 = Date.now();
  const pipe = resolveImageProps(root, { path: "pipe.png" });
  assert.ok(Date.now() - t0 < 2_000, "a FIFO must not block the event loop");
  assert.match(String(pipe.error ?? ""), /not a file|unreadable/);
  assert.match(String(resolveImageProps(root, { path: "dir.png" }).error ?? ""), /not a file|unreadable|outside/);
  assert.match(String(resolveImageProps(root, { path: "escape.png" }).error ?? ""), /outside|unreadable/);
});
