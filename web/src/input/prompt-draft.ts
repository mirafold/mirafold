/** Preserve any prompt the user was already composing. A review action adds
 * context after it; it never replaces or silently discards user-owned text. */
export function mergePromptDraft(current: string, addition: string): string {
  if (!current) return addition;
  if (!addition) return current;
  const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${addition}`;
}
