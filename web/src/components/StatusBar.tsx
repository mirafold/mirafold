import { useState } from "react";
import { ConnectDevice, type RelayInfo } from "./ConnectDevice";

// The workbench strip — model, session, cwd, connection, and token/cost
// usage at a glance. Shell-owned (the agent can't paint here) and collapsible
// per the side-surface rule: it folds to a single connection dot (T2.6).

export type Usage = {
  model?: string;
  turnIn: number;
  turnOut: number;
  sumIn: number;
  sumOut: number;
  cost: number;
};

export function tokens(n: number): string {
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
  mode,
  onToggleTheme,
  onOpenSettings,
  onEndSession,
  relay,
  version,
}: {
  connected: boolean;
  agent?: string;
  sessionId?: string;
  cwd?: string;
  usage: Usage;
  // Shell-owned theme toggle — dark is the default and the identity (4.3).
  // The pill shows the MODE (which side is active); the theme id behind
  // each side lives in Shell's slots (S.3).
  mode: "dark" | "light";
  onToggleTheme: () => void;
  // Opens the settings card (S.4) — the gear beside the pill. The card
  // itself mounts in Shell; this bar only carries the button.
  onOpenSettings?: () => void;
  // End this session (absent when there's no session yet). Two-click
  // confirm lives in this shell-owned control, never in agent output (#11).
  onEndSession?: () => void;
  // Pairing info for the "connect a device" QR (absent → no button) (R.4).
  relay?: RelayInfo;
  // The daemon's version, off the agents hello — the first thing a
  // bug report needs (R.4g).
  version?: string;
}) {
  const [open, setOpen] = useState(true);
  // First click arms, second click ends — guards against a stray click
  // killing a session. Disarms itself after a few seconds (#11).
  const [confirmEnd, setConfirmEnd] = useState(false);
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
      {/* Home (⌂ → mission control) is the outermost far-LEFT control —
          moved from the far right 2026-07-16 (Kyle); the dot stays glued to
          the agent text it reports on. */}
      <a className="sb-home" href="/" title="All sessions (mission control)">
        ⌂
      </a>
      {/* End (#11) lives with home on the left: the session-lifecycle pair,
          apart from the settings/theme cluster on the right (2026-07-16). */}
      {onEndSession && (
        <button
          className={"sb-end" + (confirmEnd ? " sb-end-armed" : "")}
          title={confirmEnd ? "Click again to end this session" : "End this session"}
          onClick={() => {
            if (confirmEnd) onEndSession();
            else {
              setConfirmEnd(true);
              setTimeout(() => setConfirmEnd(false), 3000);
            }
          }}
        >
          {confirmEnd ? "end?" : "end"}
        </button>
      )}
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
      {version && (
        <span className="sb-item sb-sep sb-version" title="Mirafold daemon version">
          v{version}
        </span>
      )}
      <ConnectDevice relay={relay} />
      {/* Settings gear (S.4) — beside the pill, which is now the far-right
          control (home moved to the far left). The pill below is LOCKED
          unchanged (Phase S). */}
      {onOpenSettings && (
        <button className="sb-settings" onClick={onOpenSettings} title="Settings">
          ⚙
        </button>
      )}
      {/* Segmented switch: both modes visible, the current one lit — nothing
          to decode as "state or action". Clicking the other side switches. */}
      <div className="sb-theme" role="group" aria-label="theme">
        <button
          className={"sb-theme-opt" + (mode === "light" ? " is-active" : "")}
          onClick={() => mode !== "light" && onToggleTheme()}
          title="Light theme"
          aria-pressed={mode === "light"}
        >
          ☀
        </button>
        <button
          className={"sb-theme-opt" + (mode === "dark" ? " is-active" : "")}
          onClick={() => mode !== "dark" && onToggleTheme()}
          title="Dark theme"
          aria-pressed={mode === "dark"}
        >
          ☾
        </button>
      </div>
    </div>
  );
}
