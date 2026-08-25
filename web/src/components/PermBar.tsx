import { useState } from "react";
import { ModalCard } from "./ModalCard";

const TITLE_ID = "perm-modal-title";

export type PermAsk = {
  tool: string;
  detail: string;
  id: string;
  /** Set when the asker is a subagent — the bar shows a dim chip. */
  parentId?: string;
};

/**
 * The permission strip and its full-command card. SHELL-OWNED UI: the agent
 * can paint nothing here, so it can't fake it. Shows the oldest pending ask;
 * allow/deny answer it on the wire via `onAnswer`.
 */
export function PermBar({
  asks,
  onAnswer,
}: {
  asks: PermAsk[];
  onAnswer: (id: string, allow: boolean) => void;
}) {
  // Which ask's full command is expanded into the card, by id — derived
  // against `asks` so the card closes ITSELF when the ask resolves elsewhere
  // (another viewport answered, or the adapter timed it out).
  const [detailAskId, setDetailAskId] = useState<string | null>(null);
  const detailAsk = detailAskId === null ? undefined : asks.find((a) => a.id === detailAskId);

  if (asks.length === 0) return null;
  return (
    <>
      <div className="perm-bar">
        {/* The whole strip minus allow/deny is ONE tap target for the
            full-command card — on a phone the preview truncates, and tapping
            the body is what a thumb tries first. */}
        <button
          className="perm-body"
          onClick={() => setDetailAskId(asks[0].id)}
          title="Show the full command"
        >
          <span className="perm-badge">permission</span>
          {asks[0].parentId && <span className="perm-subagent">subagent</span>}
          <span className="perm-tool">{asks[0].tool}</span>
          <code className="perm-detail">{asks[0].detail}</code>
          {asks.length > 1 && <span className="perm-more">+{asks.length - 1}</span>}
        </button>
        <button className="perm-allow" onClick={() => onAnswer(asks[0].id, true)}>
          allow
        </button>
        <button className="perm-deny" onClick={() => onAnswer(asks[0].id, false)}>
          deny
        </button>
      </div>
      {detailAsk && (
        <ModalCard
          overlayClass="perm-modal-backdrop"
          cardClass="perm-modal-card"
          titleId={TITLE_ID}
          onDismiss={() => setDetailAskId(null)}
        >
          <div className="perm-modal-head" id={TITLE_ID}>
            <span className="perm-badge">permission</span>
            <span className="perm-tool">{detailAsk.tool}</span>
          </div>
          <code className="perm-modal-detail" tabIndex={0}>
            {detailAsk.detail}
          </code>
        </ModalCard>
      )}
    </>
  );
}
