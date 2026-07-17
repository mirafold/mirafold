import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { AgentBackend, AgentName, SessionMeta } from "@protocol";
import { Onboarding } from "./Onboarding";
import { ConnectDevice } from "./ConnectDevice";
import { SocketClient } from "../ws";
import { tildify } from "../tildify";

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
  const [agents, setAgents] = useState<
    { agent: AgentName; live: boolean; blocked?: boolean; detail?: string; backends?: AgentBackend[] }[] | null
  >(null);
  const [daemon, setDaemon] = useState<{
    cwd?: string;
    home?: string;
    relay?: { url: string; code: string };
  }>({});
  const [connected, setConnected] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [onbError, setOnbError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // SessionId whose "end" button is armed (first click); a second click
  // ends it. Auto-disarms after a few seconds (#11).
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null);
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
          onRefresh={() => socket.send({ type: "refresh_agents" })}
          // Dismissible only when a fleet exists behind it — on first run
          // (no sessions) the picker IS the page, so it stays.
          onDismiss={
            sessions && sessions.length > 0
              ? () => {
                  setShowNew(false);
                  setOnbError(null);
                }
              : undefined
          }
        />
      )}
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
          const startRename = (e: ReactMouseEvent) => {
            e.preventDefault();
            setRenaming(s.sessionId);
          };
          return (
            // The cwd left the row proper (clutter) — it survives as the
            // row's hover tooltip, on the browser's native ~1s delay.
            <a
              key={s.sessionId}
              className="fleet-row"
              href={`/s/${s.sessionId}`}
              title={tildify(s.cwd, daemon.home)}
            >
              <span className={`fleet-dot fleet-dot-${s.status}`} title={STATUS_LABEL[s.status]} />
              {renaming === s.sessionId ? (
                <input
                  className="fleet-rename"
                  defaultValue={s.name}
                  autoFocus
                  spellCheck={false}
                  onClick={(e) => e.preventDefault()}
                  onBlur={(e) => commitRename(s.sessionId, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(s.sessionId, e.currentTarget.value);
                    else if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <span className="fleet-name">
                  {s.name}
                  <button className="fleet-edit" title="Rename this session" onClick={startRename}>
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
                onClick={(e) => {
                  e.preventDefault();
                  if (confirmEnd === s.sessionId) {
                    socket.send({ type: "end_session", sessionId: s.sessionId });
                    setConfirmEnd(null);
                  } else {
                    setConfirmEnd(s.sessionId);
                    setTimeout(
                      () => setConfirmEnd((c) => (c === s.sessionId ? null : c)),
                      3000,
                    );
                  }
                }}
              >
                {confirmEnd === s.sessionId ? "end?" : "end"}
              </button>
            </a>
          );
        })}
      </div>
    </div>
  );
}
