import { useState } from "react";

// T2.6: the workbench strip — model, session, cwd, connection, and token/cost
// usage at a glance. Shell-owned (the agent can't paint here) and collapsible
// per the side-surface rule: it folds to a single connection dot.

export type Usage = {
  model?: string;
  turnIn: number;
  turnOut: number;
  sumIn: number;
  sumOut: number;
  cost: number;
};

function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function StatusBar({
  connected,
  sessionId,
  cwd,
  usage,
}: {
  connected: boolean;
  sessionId?: string;
  cwd?: string;
  usage: Usage;
}) {
  const [open, setOpen] = useState(true);
  const dot = (
    <span
      className={`sb-dot ${connected ? "sb-dot-on" : "sb-dot-off"}`}
      title={connected ? "connected" : "reconnecting…"}
    />
  );

  if (!open) {
    return (
      <button className="status-bar status-bar-collapsed" onClick={() => setOpen(true)} title="Show status">
        {dot}
      </button>
    );
  }

  const cwdLeaf = cwd ? cwd.split("/").filter(Boolean).pop() : undefined;
  // Default sessions live at workspace/<id>, so the leaf just repeats the
  // session id — only show cwd when it actually adds something (custom dir).
  const showCwd = cwdLeaf && cwdLeaf !== sessionId;
  const hasUsage = usage.sumIn + usage.sumOut > 0;

  return (
    <div className="status-bar">
      <button className="sb-toggle" onClick={() => setOpen(false)} title="Hide status">
        {dot}
      </button>
      {usage.model && <span className="sb-item sb-model">{usage.model}</span>}
      {sessionId && <span className="sb-item sb-sep">{sessionId}</span>}
      {showCwd && (
        <span className="sb-item sb-sep sb-cwd" title={cwd}>
          {cwdLeaf}/
        </span>
      )}
      <span className="sb-spacer" />
      {hasUsage && (
        <>
          <span className="sb-item sb-usage" title="this turn (input / output tokens)">
            turn ↑{tokens(usage.turnIn)} ↓{tokens(usage.turnOut)}
          </span>
          <span className="sb-item sb-usage sb-sep" title="session total tokens">
            Σ {tokens(usage.sumIn + usage.sumOut)}
          </span>
          {usage.cost > 0 && (
            <span className="sb-item sb-usage sb-sep" title="session cost (USD)">
              ${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}
            </span>
          )}
        </>
      )}
    </div>
  );
}
