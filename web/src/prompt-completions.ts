import type { PromptOption } from "@protocol";

export type PromptCompletionMatch = {
  trigger: PromptOption["trigger"];
  query: string;
  start: number;
  end: number;
};

/** Find the provider trigger currently being edited. Slash commands are a
 * whole-prompt prefix; Codex skills may start any whitespace-delimited token. */
export function promptCompletionMatch(
  text: string,
  cursor: number,
  options: PromptOption[],
): PromptCompletionMatch | null {
  const available = new Set(options.map((option) => option.trigger));
  const before = text.slice(0, cursor);
  let trigger: PromptOption["trigger"] | undefined;
  let start = -1;
  let query = "";

  if (available.has("/") && before.startsWith("/") && !/\s/.test(before)) {
    trigger = "/";
    start = 0;
    query = before.slice(1);
  } else if (available.has("$")) {
    const match = before.match(/(?:^|\s)\$([^\s$]*)$/);
    if (match) {
      trigger = "$";
      start = before.length - match[1].length - 1;
      query = match[1];
    }
  }
  if (!trigger) return null;

  const suffix = text.slice(cursor).match(/^[^\s]*/)?.[0] ?? "";
  return { trigger, query, start, end: cursor + suffix.length };
}

export function matchingPromptOptions(
  options: PromptOption[],
  match: PromptCompletionMatch | null,
): PromptOption[] {
  if (!match) return [];
  const query = match.query.toLowerCase();
  return options.filter((option) => {
    if (option.trigger !== match.trigger) return false;
    if (option.label.toLowerCase().startsWith(query)) return true;
    return option.aliases?.some((alias) => alias.toLowerCase().startsWith(query)) ?? false;
  });
}

export function insertPromptOption(
  text: string,
  match: PromptCompletionMatch,
  option: PromptOption,
): { text: string; cursor: number } {
  const inserted = `${option.value} `;
  const end = /[ \t]/.test(text[match.end] ?? "") ? match.end + 1 : match.end;
  return {
    text: text.slice(0, match.start) + inserted + text.slice(end),
    cursor: match.start + inserted.length,
  };
}
