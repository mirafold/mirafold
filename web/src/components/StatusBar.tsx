import { useState } from "react";
import { ArmedButton } from "./ArmedButton";
import { ConnectDevice, type RelayInfo, type SubscriptionRequest } from "./ConnectDevice";
import type { SubscriptionReply } from "../subscription-card";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import { GearGlyph } from "./GearGlyph";
import { useArmedConfirm } from "../use-armed-confirm";
import { useIsPhone } from "../use-is-phone";
import { newSessionHref } from "../relay-pairing";

// The workbench strip — model, session, cwd, connection, and token/cost
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
  billing,
  subRequest,
  subReply,
  workspaceOpen,
  workspaceDisabled,
  onToggleWorkspace,
}: {
  connected: boolean;
  // Why the socket is down, when the relay refused it (no daemon / at capacity /
  // origin) — shown in the indicator instead of a bare "reconnecting…".
  connectionNote?: string;
  agent?: string;
  // Shown whenever known — session_created carries the attach-time label
  // ("default", "codex", …) and the usage stream refines it.
  model?: string;
  sessionId?: string;
  cwd?: string;
  usage: Usage;
  // Shell-owned theme toggle — dark is the default and the identity.
  // The pill shows the MODE (which side is active); the theme id behind
  // each side lives in Shell's slots.
  mode: "dark" | "light";
  onToggleTheme: () => void;
  // Opens the settings card — the gear beside the pill. The card
  // itself mounts in Shell; this bar only carries the button.
  onOpenSettings?: () => void;
  // End this session (absent when there's no session yet). Two-click
  // confirm lives in this shell-owned control, never in agent output.
  onEndSession?: () => void;
  // Pairing info for the "connect a device" QR (absent → no button).
  relay?: RelayInfo;
  // The daemon's version, off the agents hello — the first thing a
  // bug report needs.
  version?: string;
  // The workspace toggle's PHONE home: the activity bar is a desktop
  // affordance, so on ≤640px the bar hides and this ONE button opens the
  // full-screen workspace drawer (Files / Changes — the drawer's own head
  // switches between them; two side-by-side icons here are too crowded) —
  // boxed off at the far left by its own separator line (the rail's border,
  // folded into the row). Not rendered on desktop at all (useIsPhone), where
  // home must stay the bar's first control.
  workspaceOpen?: boolean;
  workspaceDisabled?: boolean;
  onToggleWorkspace?: () => void;
  // The manage-subscription plumbing, passed through to the pair
  // card (present only when the daemon runs on a license key).
  billing?: boolean;
  subRequest?: SubscriptionRequest;
  subReply?: SubscriptionReply | null;
}) {
  const [open, setOpen] = useState(true);
  const phone = useIsPhone();
  // First click arms, second click ends — guards against a stray click
  // killing a session.
  const endConfirm = useArmedConfirm<true>();
  const confirmEnd = endConfirm.armed === true;
  // The dot is a coloured circle — meaningless read aloud, so it's hidden
  // from the accessibility tree and its meaning rides on the button's label
  // instead. Live transitions are announced by Shell's Announcer.
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
  // the fuller ~-path, so a leaf is enough here.
  const cwdLeaf = cwd ? cwd.split("/").filter(Boolean).pop() : undefined;
  const showCwd = Boolean(cwdLeaf);
  const hasUsage = usage.sumIn + usage.sumOut > 0;

  return (
    <div className="status-bar">
      {/* Phone-only (desktop's activity bar owns this there): the workspace
          toggle sits one notch OUTSIDE home, boxed off as navigation distinct
          from the session controls. */}
      {phone && onToggleWorkspace && (
        <div className="sb-side-nav" aria-label="Workspace views">
          <button
            className={"sb-workspace" + (workspaceOpen ? " is-active" : "")}
            onClick={onToggleWorkspace}
            disabled={workspaceDisabled}
            title={workspaceOpen ? "Hide workspace" : "Show workspace (files and changes)"}
            aria-label="Workspace"
            aria-expanded={workspaceOpen}
          >
            <WorkspaceGlyph size={20} />
          </button>
        </div>
      )}
      {/* Home (⌂ → mission control) is the outermost far-LEFT control; the
          dot stays glued to the agent text it reports on. (The brand mark
          belongs to the empty-session welcome in RenderZone, not here.) */}
      <a className="sb-home" href="/" title="All sessions (mission control)">
        ⌂
      </a>
      {/* "new" sits beside home: a new browser tab on the startup screen, so
          a session can be spun up from inside any session. ?new opens mission
          control with the picker already up. End sits at the far right, past
          the theme pill. On the relay path the href carries the pairing
          fragment forward — a new tab inherits neither the fragment nor
          sessionStorage, so without this the new tab has no daemon to reach
          and hangs on "connecting". */}
      <a
        className="sb-new"
        href={newSessionHref()}
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
      {/* The refusal reason, visible: a relay refusal's WHY can't live
          only in the dot's title — a hover tooltip no touch device can
          reveal, on the path built for phones.
          Shown only when down WITH a known reason; an ordinary blip keeps
          the quiet dot and the plain "reconnecting…" tooltip. No live
          region here — Shell's Announcer already speaks the transition;
          this is the visible copy of the same words. */}
      {!connected && connectionNote && (
        <span className="sb-item sb-conn-note">{connectionNote}</span>
      )}
      {/* The agent chip is the session's identity element — tapping it opens
          the settings card's Session section ("what is this session?"), the
          phone's path to the facts the bar doesn't carry inline. */}
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
          when imperfect ("default", agent-named). */}
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
      <ConnectDevice
        relay={relay}
        sessionId={sessionId}
        billing={billing}
        subRequest={subRequest}
        subReply={subReply}
      />
      {/* Settings gear — beside the pill, the far-right control. The pill
          below is LOCKED unchanged. */}
      {onOpenSettings && (
        <button
          className="sb-settings"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          <GearGlyph size={20} />
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
      {/* End is the outermost far-RIGHT control, past the theme pill —
          two-click confirm, shell-owned. */}
      {onEndSession && (
        <ArmedButton
          className="sb-end"
          verb="end"
          armed={confirmEnd}
          title="End this session"
          armedTitle="Click again to end this session"
          onArm={() => endConfirm.arm(true)}
          onFire={onEndSession}
        />
      )}
    </div>
  );
}
