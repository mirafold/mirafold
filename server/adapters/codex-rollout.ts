import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

/** `<codexHome>/sessions/YYYY/MM/DD` — the CLI's rollout layout, LOCAL date.
 * Exported for test fixtures so the layout is written down exactly once. */
export const rolloutDateDir = (codexHome: string, date: Date) =>
  path.join(
    codexHome,
    "sessions",
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );

/**
 * Read the model Codex actually resolved for a thread from its rollout file.
 * The SDK event stream does not expose this value. The lookup is local,
 * read-only, and failure-silent; a miss leaves the caller's label unresolved.
 */
export async function resolveRolloutModel(
  threadId: string,
  codexHome: string,
): Promise<string | undefined> {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  for (const dir of [rolloutDateDir(codexHome, today), rolloutDateDir(codexHome, yesterday)]) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const file = names.find((name) => name.endsWith(`-${threadId}.jsonl`));
    if (!file) continue;
    let text: string;
    try {
      text = await readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"model"')) continue;
      try {
        const model = (JSON.parse(line) as { payload?: { model?: unknown } }).payload?.model;
        if (typeof model === "string" && model) return model;
      } catch {
        // A line can be observed while Codex is still writing it. A later
        // polling attempt will see the completed JSON record.
      }
    }
  }
  return undefined;
}

/** Bounded polling around the rollout read. The thread context is written a
 * few seconds after `thread.started`; `turn.completed` may safely re-enter
 * this lookup because concurrent attempts are suppressed. */
export class CodexRolloutLookup {
  private running = false;

  async learn(options: {
    threadId: () => string | undefined;
    codexHome: () => string;
    shouldContinue: () => boolean;
    onResolved: (model: string) => void;
  }): Promise<void> {
    if (this.running || !options.threadId()) return;
    this.running = true;
    try {
      for (let attempt = 0; attempt < 20 && options.shouldContinue(); attempt++) {
        const threadId = options.threadId();
        if (!threadId) return;
        const model = await resolveRolloutModel(threadId, options.codexHome());
        if (model) {
          options.onResolved(model);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      this.running = false;
    }
  }
}
