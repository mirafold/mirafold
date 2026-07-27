// The image render tool's server half: the agent authors a workspace PATH
// (inlining megabytes of base64 into tool arguments is token-impossible), and
// the DAEMON turns it into a data: URI riding the render WireMsg — the one
// transport every viewport shares, local and relay alike. Resolution happens
// where the WireMsg is synthesized (render-tools for Claude in-process,
// generativeUIMsg for the stdio adapters); the stdio stub itself stays a thin
// schema-only process with no file access.
//
// Security posture mirrors the Explorer's read path: realpath containment via
// `inside()` (a planted symlink can't walk out), the secret-file denial, a
// hard byte cap, and a magic-byte allowlist of RASTER formats only — SVG is
// deliberately excluded (it's a document format with script surface, not a
// picture). Whatever the agent put in `src`/`error` never survives: those
// fields are daemon-filled here or absent.

import { readFileSync, statSync } from "node:fs";
import { inside } from "./sessions/actions";
import { isSecretFile } from "./security/permissions";

/** Raw-file cap. The sealed relay frame inflates ~1.8× over raw bytes
 *  (base64-in-JSON, then the E2E seal's encoding), and the relay's default
 *  frame ceiling is 8 MB — 2 MB raw keeps a wide margin. It also bounds what
 *  one image costs the session's replay ring (count-capped, not byte-capped),
 *  which re-sends every buffered render on resume. */
export const IMAGE_MAX_BYTES = 2_000_000;

const SNIFFS: [kind: string, ok: (b: Buffer) => boolean][] = [
  ["png", (b) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47],
  ["jpeg", (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["gif", (b) => b.length >= 6 && b.toString("latin1", 0, 4) === "GIF8"],
  [
    "webp",
    (b) =>
      b.length >= 12 &&
      b.toString("latin1", 0, 4) === "RIFF" &&
      b.toString("latin1", 8, 12) === "WEBP",
  ],
];

/** Resolves an agent-authored image render into wire props: `src` filled on
 *  success, `error` on refusal — never both, and never anything the agent
 *  wrote in either field. Synchronous on purpose (the fs-explorer precedent):
 *  the read is byte-capped, so no call holds the event loop meaningfully. */
export function resolveImageProps(
  root: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of ["path", "alt", "caption"]) {
    if (typeof props[key] === "string") clean[key] = props[key];
  }
  const fail = (error: string) => ({ ...clean, error });
  const rel = clean["path"];
  if (typeof rel !== "string") return fail("no path given");
  // inside() realpaths the candidate, so a nonexistent file and an escaping
  // one both come back null — the message honestly covers both.
  const abs = inside(root, rel);
  if (!abs) return fail("missing, or outside the workspace");
  if (isSecretFile(abs)) return fail("not an image file");
  let buf: Buffer;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return fail("not a file");
    if (st.size > IMAGE_MAX_BYTES) {
      return fail(`too large (${(st.size / 1e6).toFixed(1)} MB; the cap is 2 MB)`);
    }
    buf = readFileSync(abs);
  } catch {
    return fail("unreadable");
  }
  // The file can grow between stat and read — re-check what was actually read.
  if (buf.length > IMAGE_MAX_BYTES) return fail("too large (the cap is 2 MB)");
  const kind = SNIFFS.find(([, ok]) => ok(buf))?.[0];
  if (!kind) return fail("not a png/jpeg/gif/webp");
  return { ...clean, src: `data:image/${kind};base64,${buf.toString("base64")}` };
}
