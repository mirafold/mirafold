import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentInfo, SessionMeta } from "@protocol";
import { Onboarding } from "./Onboarding";
import { ConnectDevice } from "./ConnectDevice";
import { SocketClient } from "../ws";
import { tildify } from "../tildify";
import { useArmedConfirm } from "../use-armed-confirm";

// 4.6 Mission control: the root page is an ambient supervision surface —
// every live session in the registry with name, cwd, coarse status, and last
// activity, each row dropping into its transcript at /s/<id>. This is shell
// UI end to end: agent output can never paint here.

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const STATUS_LABEL = { idle: "idle", working: "working", permission: "needs you" } as const;

export function FleetView() {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [daemon, setDaemon] = useState<{
    cwd?: string;
    home?: string;
    relay?: { url: string; code: string };
  }>({});
  const [connected, setConnected] = useState(false);
  // ?new=1 lands straight on the picker — that's the URL the in-session "new"
  // button opens in a fresh tab (2026-07-20, Kyle).
  const [showNew, setShowNew] = useState(() => new URLSearchParams(location.search).has("new"));
  const [onbError, setOnbError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // SessionId whose "end" button is armed (first click); a second click
  // ends it (#11).
  const endConfirm = useArmedConfirm<string>();
  const confirmEnd = endConfirm.armed;
  const [, setTick] = useState(0); // re-render so the "ago" labels stay honest

  const socket = useMemo(() => {
    const s = new SocketClient();
    s.setHello(() => ({ type: "watch_sessions" }));
    return s;
  }, []);

  useEffect(() => {
    const offMsg = socket.onMessage((m) => {
      if (m.type === "sessions") setSessions(m.sessions);
      else if (m.type === "agents") {
        setAgents(m.agents);
        setDaemon({ cwd: m.cwd, home: m.home, relay: m.relay });
      } else if (m.type === "session_created") {
        // The create issued from the onboarding card below: enter the session.
        location.assign(`/s/${m.sessionId}`);
      } else if (m.type === "error") {
        setOnbError(m.message);
      }
    });
    const offOpen = socket.onOpen(() => setConnected(true));
    const offClose = socket.onClose(() => setConnected(false));
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      offMsg();
      offOpen();
      offClose();
      clearInterval(timer);
      socket.close();
    };
  }, [socket]);

  useEffect(() => {
    document.title = "Mirafold — sessions";
  }, []);

  // Stable identity: Onboarding keys its poll interval on this prop, so a
  // fresh arrow each render would restart the 3s timer instead of letting
  // it fire.
  const refreshAgents = useCallback(() => socket.send({ type: "refresh_agents" }), [socket]);

  const commitRename = (id: string, name: string) => {
    setRenaming(null);
    if (name.trim()) socket.send({ type: "rename", sessionId: id, name });
  };

  // First run (no sessions yet) opens straight into "choose your agent".
  const onboarding = showNew || (sessions !== null && sessions.length === 0);

  return (
    <div className="fleet">
      {onboarding && (
        <Onboarding
          agents={agents}
          defaultCwd={tildify(daemon.cwd, daemon.home)}
          error={onbError}
          onPick={(agent, cwd, backend) => {
            setOnbError(null);
            socket.send({ type: "create", agent, cwd, ...(backend ? { backend } : {}) });
          }}
          onRefresh={refreshAgents}
          // Dismissible only when a fleet exists behind it — on first run
          // (no sessions) the picker IS the page, so it stays.
          onDismiss={
            sessions && sessions.length > 0
              ? () => {
                  setShowNew(false);
                  setOnbError(null);
                  // Drop ?new so a reload doesn't reopen the picker.
                  history.replaceState(null, "", location.pathname);
                }
              : undefined
          }
        />
      )}
      <div className="behind-dialog" inert={onboarding || undefined}>
        <header className="fleet-head">
          <span className="glyph">❯</span>
          <h1 className="fleet-title">Mirafold</h1>
          <span className={`sb-dot ${connected ? "sb-dot-on" : "sb-dot-off"}`} />
          <span className="fleet-count">
            {sessions === null ? "connecting…" : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
          </span>
          <span className="fleet-spacer" />
          <ConnectDevice relay={daemon.relay} />
          <button className="fleet-new" onClick={() => setShowNew(true)}>
            + new session
          </button>
        </header>
        <div className="fleet-list">
          {(sessions ?? []).map((s) => {
            return (
              // A.3b: the row is a plain container, NOT an anchor — buttons
              // inside a link are invalid HTML and made screen readers read the
              // whole row (id, status, "end") as one link label. The session
              // NAME is the link; its stretched overlay (.fleet-link::after)
              // keeps click-anywhere-to-open for mouse users, and the real
              // controls ride above the overlay.
              // The cwd stays OFF the row (an on-row column was tried
              // 2026-07-22 and re-removed the same day as clutter — Kyle):
              // desktop gets it on hover here; phone gets it in the settings
              // card's Session section, one tap inside.
              <div key={s.sessionId} className="fleet-row" title={tildify(s.cwd, daemon.home)}>
                <span className={`fleet-dot fleet-dot-${s.status}`} title={STATUS_LABEL[s.status]} />
                {renaming === s.sessionId ? (
                  <input
                    className="fleet-rename"
                    defaultValue={s.name}
                    autoFocus
                    spellCheck={false}
                    onBlur={(e) => commitRename(s.sessionId, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(s.sessionId, e.currentTarget.value);
                      else if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="fleet-name">
                    <a className="fleet-link" href={`/s/${s.sessionId}`}>
                      {s.name}
                    </a>
                    <button
                      className="fleet-edit"
                      title="Rename this session"
                      aria-label={`Rename session ${s.name}`}
                      onClick={() => setRenaming(s.sessionId)}
                    >
                      ✎
                    </button>
                  </span>
                )}
                {/* Agent before model, matching the in-session status bar (2026-07-17, Kyle). */}
                <span className="fleet-agent">{s.agent}</span>
                <span className="fleet-model" title="model">
                  {s.model}
                </span>
                <span className="fleet-spacer" />
                <span className="fleet-id" title="session id">
                  {s.sessionId}
                </span>
                <span className="fleet-sep" aria-hidden="true">
                  —
                </span>
                <span className={`fleet-status fleet-status-${s.status}`}>
                  {STATUS_LABEL[s.status]}
                </span>
                <span className="fleet-ago">{ago(s.lastActivity)}</span>
                <button
                  className={"fleet-end" + (confirmEnd === s.sessionId ? " fleet-end-armed" : "")}
                  title={
                    confirmEnd === s.sessionId
                      ? "Click again to end this session"
                      : "End this session"
                  }
                  aria-label={
                    confirmEnd === s.sessionId
                      ? `Click again to end session ${s.name}`
                      : `End session ${s.name}`
                  }
                  onClick={() => {
                    if (confirmEnd === s.sessionId) {
                      socket.send({ type: "end_session", sessionId: s.sessionId });
                      endConfirm.disarm();
                    } else {
                      endConfirm.arm(s.sessionId);
                    }
                  }}
                >
                  {confirmEnd === s.sessionId ? "end?" : "end"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
