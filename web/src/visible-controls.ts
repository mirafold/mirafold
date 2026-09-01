/**
 * Make direction and invisible control characters VISIBLE on a surface the
 * user answers or acts on. A Bash `command` carrying U+202E (right-to-left
 * override) reads on the permission bar as a different command than the one
 * that will run (Trojan Source); the prompt catalog already refuses such
 * entries server-side (prompt-options.ts), but an ask must show the engine's
 * exact bytes — so they are rendered, never altered: each control becomes a
 * marked ‹U+XXXX› token (audit 2026-08-26). Pair with `unicode-bidi: isolate`
 * on the container so surrounding text cannot be re-ordered either.
 */
// Also marks Unicode tag characters (U+E0001, U+E0020–E007F: invisible ASCII
// smuggling) and interlinear annotation controls; variation selectors stay —
// they alter a glyph's look, never hide or re-order other text.
const CONTROL =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0001}\u{e0020}-\u{e007f}]/gu;

export function visibleControls(s: string): string {
  return s.replace(CONTROL, (c) => `‹U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}›`);
}
