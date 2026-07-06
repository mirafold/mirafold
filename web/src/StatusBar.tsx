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
  agent,
  sessionId,
  cwd,
  usage,
  theme,
  onToggleTheme,
}: {
  connected: boolean;
  agent?: string;
  sessionId?: string;
  cwd?: string;
  usage: Usage;
  // 4.3: shell-owned theme toggle — dark is the default and the identity.
  theme: "dark" | "light";
  onToggleTheme: () => void;
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

  // The leaf names the project (session ≈ project); the prompt line carries
  // the fuller ~-path (Step 4.8), so a leaf is enough here.
  const cwdLeaf = cwd ? cwd.split("/").filter(Boolean).pop() : undefined;
  const showCwd = Boolean(cwdLeaf);
  const hasUsage = usage.sumIn + usage.sumOut > 0;

  return (
    <div className="status-bar">
      <button className="sb-toggle" onClick={() => setOpen(false)} title="Hide status">
        {dot}
      </button>
      {agent && <span className="sb-item sb-agent" title="the terminal agent behind this session">{agent}</span>}
      {/* Model only when it adds something beyond the agent name (e.g. codex→codex is redundant). */}
      {usage.model && usage.model !== agent && (
        <span className="sb-item sb-model sb-sep">{usage.model}</span>
      )}
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
      <button
        className="sb-theme"
        onClick={onToggleTheme}
        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      >
        {theme === "dark" ? "☾" : "☀"}
      </button>
    </div>
  );
}
