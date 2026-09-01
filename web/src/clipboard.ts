/**
 * Copy `text` to the clipboard from a user gesture, and say whether anything
 * was written. The async Clipboard API is the first choice, but it is refused
 * wherever the embedder withholds the permission — Mirafold Desktop's
 * default-deny policy denies `clipboard-sanitized-write`, so every painting's
 * copy button was a dead click there (2026-08-31) — and it is absent outside a
 * secure context. The legacy path, `execCommand("copy")` over a selected
 * off-screen textarea, is gated only on the gesture and works in both.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused or unavailable: fall through to the selection path.
  }
  return copyViaSelection(text);
}

function copyViaSelection(text: string): boolean {
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.cssText = "position:fixed;top:-1000px";
  document.body.appendChild(area);
  area.select();
  let wrote = false;
  try {
    wrote = document.execCommand("copy");
  } catch {
    // unsupported: wrote stays false
  }
  area.remove();
  previous?.focus({ preventScroll: true });
  return wrote;
}
