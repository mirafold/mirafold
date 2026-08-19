import type {
  ArtifactRow,
  OutputZoneRow,
  RenderRow,
  TextRow,
} from "./transcript-projection";

export type AssistantTextRow = TextRow & { role: "assistant" };

export type ResponseDocumentRow = AssistantTextRow | RenderRow | ArtifactRow;

export type TranscriptDisplayItem =
  | {
      kind: "entry";
      key: number;
      row: OutputZoneRow;
    }
  | {
      kind: "response-document";
      /** Stable for this DOM segment: the first eligible projected row id. */
      key: number;
      /** Stable across soft shell interruptions until a hard user boundary. */
      responseKey: number;
      continuation: boolean;
      rows: readonly ResponseDocumentRow[];
    };

export function isResponseDocumentRow(
  row: OutputZoneRow,
): row is ResponseDocumentRow {
  return (
    row.kind === "render" ||
    row.kind === "artifact" ||
    (row.kind === "text" && row.role === "assistant")
  );
}

/** User-authored transcript interactions begin a new response sequence. */
function isHardBoundary(row: OutputZoneRow): boolean {
  return (row.kind === "text" && row.role === "user") || row.kind === "bang";
}

/**
 * Pure presentation grouping over the projection's already-visible rows.
 * Shell/provider rows stay top-level. They split DOM document segments but,
 * unless user-authored, retain the surrounding responseKey so later styling
 * can preserve one visual rhythm without absorbing trusted chrome into prose.
 */
export function groupResponseDocuments(
  rows: readonly OutputZoneRow[],
): readonly TranscriptDisplayItem[] {
  const display: TranscriptDisplayItem[] = [];
  let pending: ResponseDocumentRow[] = [];
  let responseKey: number | null = null;
  let hasDocumentInResponse = false;

  const flushDocument = () => {
    const first = pending[0];
    if (!first || responseKey === null) return;
    display.push({
      kind: "response-document",
      key: first.id,
      responseKey,
      continuation: hasDocumentInResponse,
      rows: pending,
    });
    pending = [];
    hasDocumentInResponse = true;
  };

  for (const row of rows) {
    if (isResponseDocumentRow(row)) {
      if (responseKey === null) responseKey = row.id;
      pending.push(row);
      continue;
    }

    flushDocument();
    display.push({ kind: "entry", key: row.id, row });
    if (isHardBoundary(row)) {
      responseKey = null;
      hasDocumentInResponse = false;
    }
  }

  flushDocument();
  return display;
}
