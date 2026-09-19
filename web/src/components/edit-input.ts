import { diffLines, unifiedDiffLines, wholeFileLines, type DiffLine } from "../workspace/diff";

const MAX_CHARS = 200_000;
const MAX_ITEMS = 200;
export const EDIT_PREVIEW_ROWS = 12;
export const EDIT_PREVIEW_FILES = 3;

export type EditFile = { label: string; lines: DiffLine[]; written?: boolean; moved?: boolean };
export type EditInput = {
  files: EditFile[];
  counts?: { added: number; removed: number };
  unavailable?: string;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** One bounded preparation shared by the badge, preview and expansion. The
 *  original input is never truncated, including when preparation is declined. */
export function prepareEditInput(name: string, input?: Record<string, unknown>): EditInput | undefined {
  if (!input || !["Edit", "MultiEdit", "Write", "apply_patch"].includes(name)) return undefined;
  const unavailable = (reason: string): EditInput => ({ files: [], unavailable: reason });
  const raws = name === "apply_patch" ? input["changes"]
    : Array.isArray(input["edits"]) ? input["edits"] : [input];
  if (!Array.isArray(raws) || raws.length === 0) return unavailable("No supported edit preview");
  if (raws.length > MAX_ITEMS) return unavailable("Large edit — preview omitted");
  let chars = 0;
  const jobs: (() => EditFile)[] = [];
  for (const raw of raws) {
    const item = record(raw);
    if (!item) return unavailable("No supported edit preview");
    const filePath = typeof item["file_path"] === "string" ? item["file_path"]
      : typeof input["file_path"] === "string" ? input["file_path"] : "(path unavailable)";
    if (name === "apply_patch") {
      const diff = item["diff"];
      if (typeof diff !== "string" || !["add", "delete", "update"].includes(String(item["kind"]))) return unavailable("No supported edit preview");
      const kind = item["kind"];
      const path = typeof item["path"] === "string" ? item["path"] : "(path unavailable)";
      const move = typeof item["movePath"] === "string" ? item["movePath"] : undefined;
      chars += diff.length + path.length + (move?.length ?? 0);
      jobs.push(() => ({
        label: move ? `Moved ${path} → ${move}` : `${kind === "add" ? "Added" : kind === "delete" ? "Deleted" : "Updated"} ${path}`,
        moved: !!move,
        lines: kind === "update" ? unifiedDiffLines(diff) : wholeFileLines(diff, kind === "add" ? "+" : "-"),
      }));
    } else if (name === "Write") {
      const content = item["content"];
      if (typeof content !== "string") return unavailable("No supported edit preview");
      chars += content.length + filePath.length;
      jobs.push(() => ({ label: `Written content · ${filePath}`, written: true, lines: wholeFileLines(content, "+") }));
    } else {
      const before = item["old_string"], after = item["new_string"];
      if (typeof before !== "string" || typeof after !== "string") return unavailable("No supported edit preview");
      chars += before.length + after.length + filePath.length;
      jobs.push(() => ({ label: `Updated ${filePath}`, lines: diffLines(before, after) }));
    }
    if (chars > MAX_CHARS) return unavailable("Large edit — preview omitted");
  }
  const files = jobs.map((job) => job());
  // A write supplies no old contents: its size cannot establish additions.
  if (name === "Write") return { files };
  const counts = { added: 0, removed: 0 };
  for (const file of files) for (const line of file.lines) {
    if (line.sign === "+") counts.added++;
    if (line.sign === "-") counts.removed++;
  }
  return { files, counts };
}

/** Starts at actual changed text, never spends the budget on hunk headers.
 *  EOF annotations consume a visible row too. */
export function editPreview(prepared: EditInput): { files: EditFile[]; omitted: boolean } {
  const files: EditFile[] = [];
  let remaining = EDIT_PREVIEW_ROWS;
  let omitted = !!prepared.unavailable;
  for (const file of prepared.files) {
    const start = file.lines.findIndex((line) => line.sign !== " ");
    if (start < 0 && !file.moved && !file.written) continue;
    if (files.length === EDIT_PREVIEW_FILES || remaining === 0) { omitted = true; continue; }
    const lines: DiffLine[] = [];
    let index = Math.max(0, start);
    let contextRows = 0;
    for (; index < file.lines.length; index++) {
      const line = file.lines[index];
      contextRows = line.sign === " " ? contextRows + 1 : 0;
      if (contextRows > 2) break;
      const cost = 1 + Number(!!line.noNewline);
      if (cost > remaining) break;
      lines.push(line);
      remaining -= cost;
    }
    omitted ||= start > 0 || index < file.lines.length;
    if (lines.length === 0 && file.lines.length > 0) continue;
    files.push({ ...file, lines });
  }
  return { files, omitted };
}
