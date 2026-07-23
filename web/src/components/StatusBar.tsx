import { useState } from "react";
import { ConnectDevice, type RelayInfo } from "./ConnectDevice";
import { useArmedConfirm } from "../use-armed-confirm";

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

/* Session cost in dollars — sub-dollar amounts keep a third decimal so a
   cheap session doesn't round to a misleading $0.00. */
export function cost(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

export function StatusBar({
  connected,
  connectionNote,
  agent,
  model,
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
  // Why the socket is down, when the relay refused it (no daemon / at capacity /
  // origin) — shown in the indicator instead of a bare "reconnecting…".
  connectionNote?: string;
  agent?: string;
  // Shown whenever known — session_created carries the attach-time label
  // ("default", "codex", …) and the usage stream refines it (2026-07-17, Kyle).
  model?: string;
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
  // killing a session (#11).
  const endConfirm = useArmedConfirm<true>();
  const confirmEnd = endConfirm.armed === true;
  // The dot is a coloured circle — meaningless read aloud, so it's hidden
  // from the accessibility tree and its meaning rides on the button's label
  // instead (A.1). Live transitions are announced by Shell's Announcer.
  const dotState = connected ? "connected" : (connectionNote ?? "reconnecting…");
  const dot = (
    <span className={`sb-dot ${connected ? "sb-dot-on" : "sb-dot-off"}`} title={dotState} aria-hidden="true" />
  );

  if (!open) {
    return (
      <button
        className="status-bar status-bar-collapsed"
        onClick={() => setOpen(true)}
        title="Show status"
        aria-label={`Show status — ${dotState}`}
      >
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
          the agent text it reports on. (A brand-M-as-home experiment lived
          here for part of 2026-07-18 — reverted, Kyle's call; the brand mark
          moved to the empty-session welcome in RenderZone instead.) */}
      <a className="sb-home" href="/" title="All sessions (mission control)">
        ⌂
      </a>
      {/* "new" sits beside home (2026-07-20, Kyle): a new browser tab on the
          startup screen, so a session can be spun up from inside any session.
          ?new opens mission control with the picker already up. End moved to
          the far right, past the theme pill. */}
      <a
        className="sb-new"
        href="/?new=1"
        target="_blank"
        rel="noopener"
        title="New session (opens a new tab)"
      >
        new
      </a>
      <button
        className="sb-toggle"
        onClick={() => setOpen(false)}
        title="Hide status"
        aria-label={`Hide status — ${dotState}`}
      >
        {dot}
      </button>
      {/* The agent chip is the session's identity element — tapping it opens
          the settings card's Session section ("what is this session?"), the
          phone's path to the facts the bar no longer carries inline (R.4l). */}
      {agent &&
        (onOpenSettings ? (
          <button
            className="sb-item sb-agent sb-agent-btn"
            onClick={onOpenSettings}
            title="Session details"
          >
            {agent}
          </button>
        ) : (
          <span className="sb-item sb-agent" title="the terminal agent behind this session">
            {agent}
          </span>
        ))}
      {/* Agent then model, left to right — model shown whenever known, even
          when imperfect ("default", agent-named) (2026-07-17, Kyle). */}
      {model && <span className="sb-item sb-model sb-sep" title="model">{model}</span>}
      {sessionId && <span className="sb-item sb-sep sb-session">{sessionId}</span>}
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
              {cost(usage.cost)}
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
      {/* End (#11) is the outermost far-RIGHT control, past the theme pill
          (2026-07-20, Kyle) — two-click confirm, shell-owned. */}
      {onEndSession && (
        <button
          className={"sb-end" + (confirmEnd ? " sb-end-armed" : "")}
          title={confirmEnd ? "Click again to end this session" : "End this session"}
          onClick={() => {
            if (confirmEnd) onEndSession();
            else endConfirm.arm(true);
          }}
        >
          {confirmEnd ? "end?" : "end"}
        </button>
      )}
    </div>
  );
}
