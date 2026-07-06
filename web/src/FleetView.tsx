import { useEffect, useMemo, useState } from "react";
import type { AgentName, SessionMeta } from "@protocol";
import { Onboarding } from "./Onboarding";
import { SocketClient } from "./ws";

// 4.6 Mission control: the root page is an ambient supervision surface —
// every live session in the registry with name, cwd, coarse status, and last
// activity, each row dropping into its transcript at /s/<id>. This is shell
// UI end to end: agent output can never paint here.

const AGENT_LABEL: Record<AgentName, string> = {
  "claude-code": "claude-code",
  codex: "codex",
  "gemini-cli": "gemini-cli",
};

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
  const [agents, setAgents] = useState<{ agent: AgentName; live: boolean }[] | null>(null);
  const [daemon, setDaemon] = useState<{ cwd?: string; home?: string }>({});
  const [connected, setConnected] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [onbError, setOnbError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
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
        setDaemon({ cwd: m.cwd, home: m.home });
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
    document.title = "genui-shell — sessions";
  }, []);

  const tildify = (p: string) =>
    daemon.home && (p === daemon.home || p.startsWith(daemon.home + "/"))
      ? "~" + p.slice(daemon.home.length)
      : p;

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
          defaultCwd={daemon.cwd ? tildify(daemon.cwd) : undefined}
          error={onbError}
          onPick={(agent, cwd) => {
            setOnbError(null);
            socket.send({ type: "create", agent, cwd });
          }}
        />
      )}
      <header className="fleet-head">
        <span className="glyph">❯</span>
        <h1 className="fleet-title">genui-shell</h1>
        <span className={`sb-dot ${connected ? "sb-dot-on" : "sb-dot-off"}`} />
        <span className="fleet-count">
          {sessions === null ? "connecting…" : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
        </span>
        <span className="fleet-spacer" />
        <button className="fleet-new" onClick={() => setShowNew(true)}>
          + new session
        </button>
      </header>
      <div className="fleet-list">
        {(sessions ?? []).map((s) => (
          <a key={s.sessionId} className="fleet-row" href={`/s/${s.sessionId}`}>
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
                <button
                  className="fleet-edit"
                  title="Rename"
                  onClick={(e) => {
                    e.preventDefault();
                    setRenaming(s.sessionId);
                  }}
                >
                  ✎
                </button>
              </span>
            )}
            <span className="fleet-id">{s.sessionId}</span>
            <span className="fleet-agent">{AGENT_LABEL[s.agent] ?? s.agent}</span>
            <span className="fleet-cwd" title={s.cwd}>
              {tildify(s.cwd)}
            </span>
            <span className="fleet-spacer" />
            <span className={`fleet-status fleet-status-${s.status}`}>
              {STATUS_LABEL[s.status]}
            </span>
            <span className="fleet-ago">{ago(s.lastActivity)}</span>
            {s.viewports > 0 && (
              <span className="fleet-views" title={`${s.viewports} open tab(s)`}>
                ⧉ {s.viewports}
              </span>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
