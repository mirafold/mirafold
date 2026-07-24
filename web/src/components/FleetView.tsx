import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, SessionMeta } from "@protocol";
import { Onboarding } from "./Onboarding";
import { ConnectDevice } from "./ConnectDevice";
import { SocketClient } from "../ws";
import { tildify } from "../tildify";
import { useArmedConfirm } from "../use-armed-confirm";

// 4.6 Mission control, grown into the Phase M cockpit: every live session in
// the registry with name, cwd, live activity, pending permission, and usage —
// and the grid acts on sessions (answer a permission, interrupt, dispatch a
// prompt) without entering them. This is shell UI end to end: agent output
// can never paint here, and every engine-derived string (activity label,
// permission detail) renders as inert plain text — never markdown.

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Elapsed-time readout beside the activity label ("14s", "2m", "1h"). */
function elapsed(since: number): string {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** Compact token count ("870", "12.3k", "1.2M") — the cockpit's own small
 *  formatter; StatusBar's display is its own (never imported across). */
function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** The activity line, glyph-prefixed like the in-session status line:
 *  "✳ thinking", "⚙ Bash", and a bang label ("! cmd") kept as-is. */
function activityText(a: NonNullable<SessionMeta["activity"]>): string {
  const head = a.label === "thinking" ? "✳ thinking" : a.label.startsWith("! ") ? a.label : `⚙ ${a.label}`;
  return `${head} · ${elapsed(a.since)}`;
}

const STATUS_LABEL = { idle: "idle", working: "working", permission: "needs you" } as const;

/** Cockpit ordering (Kyle's call, Phase M): rows hold a stable creation
 *  order so eyes can park on a session; the one exception is sessions
 *  awaiting permission, which surface to a top group — longest-stalled
 *  first (their stream is blocked, so lastActivity is when they stalled).
 *  `createdAt` is optional on the wire (old daemon); absent → the wire
 *  order holds (the sort is stable). */
function cockpitOrder(sessions: SessionMeta[]): SessionMeta[] {
  const rank = (s: SessionMeta) => (s.status === "permission" ? 0 : 1);
  return [...sessions].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 0 ? a.lastActivity - b.lastActivity : (a.createdAt ?? 0) - (b.createdAt ?? 0)),
  );
}

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
  // A fleet ACT's error reply (unknown session, relay gate) — a dismissible
  // header line, kept apart from the onboarding card's error slot (M.3).
  const [actionError, setActionError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // SessionId whose "end" button is armed (first click); a second click
  // ends it (#11). The stop (interrupt) button gets the same two-click arm.
  const endConfirm = useArmedConfirm<string>();
  const confirmEnd = endConfirm.armed;
  const stopConfirm = useArmedConfirm<string>();
  const confirmStop = stopConfirm.armed;
  // Permission ids already answered from the grid — buttons disable
  // instantly; the next snapshot (queue dropped server-side) prunes them.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // SessionId whose quick-prompt line is open (one at a time).
  const [promptFor, setPromptFor] = useState<string | null>(null);
  const [, setTick] = useState(0); // re-render so ago/elapsed labels stay honest

  const socket = useMemo(() => {
    const s = new SocketClient();
    s.setHello(() => ({ type: "watch_sessions" }));
    return s;
  }, []);

  // The socket's message handler lives for the socket's life; it reads the
  // picker's openness through this ref so error ROUTING follows the live
  // value (picker open → its card; otherwise → the header line).
  const showNewRef = useRef(false);

  useEffect(() => {
    const offMsg = socket.onMessage((m) => {
      if (m.type === "sessions") {
        setSessions(m.sessions);
        // Answered ids leave the set once the server's queue no longer
        // carries them — the set stays bounded to what's actually pending.
        setAnswered((prev) => {
          const pending = new Set(
            m.sessions.flatMap((s) => (s.permissions ?? []).map((p) => p.id)),
          );
          const kept = [...prev].filter((id) => pending.has(id));
          return kept.length === prev.size ? prev : new Set(kept);
        });
      } else if (m.type === "agents") {
        setAgents(m.agents);
        setDaemon({ cwd: m.cwd, home: m.home, relay: m.relay });
      } else if (m.type === "session_created") {
        // The create issued from the onboarding card below: enter the session.
        location.assign(`/s/${m.sessionId}`);
      } else if (m.type === "error") {
        // While the picker is open its card owns errors (a refused create);
        // otherwise the reply belongs to a grid act — the header line (M.3).
        if (showNewRef.current) setOnbError(m.message);
        else setActionError(m.message);
      }
    });
    const offOpen = socket.onOpen(() => setConnected(true));
    const offClose = socket.onClose(() => setConnected(false));
    return () => {
      offMsg();
      offOpen();
      offClose();
      socket.close();
    };
  }, [socket]);

  // Ago labels are honest at 30s; the second-resolution elapsed readout wants
  // a 1s tick — but only while something is actually active, so an idle
  // fleet page stays quiet.
  const hasLive = (sessions ?? []).some((s) => s.activity || s.status === "working");
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), hasLive ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [hasLive]);

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

  const answerPermission = (sessionId: string, id: string, allow: boolean) => {
    socket.send({ type: "answer_permission", sessionId, id, allow });
    setAnswered((prev) => new Set([...prev, id]));
  };

  const sendQuickPrompt = (sessionId: string, text: string) => {
    if (text.trim()) socket.send({ type: "prompt_session", sessionId, text });
    setPromptFor(null);
  };

  // First run (no sessions yet) opens straight into "choose your agent".
  const onboarding = showNew || (sessions !== null && sessions.length === 0);
  showNewRef.current = onboarding;

  const ordered = cockpitOrder(sessions ?? []);
  const needsYou = ordered.filter((s) => s.status === "permission").length;

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
        {/* Screen-reader pulse for the cockpit's "act here" state (M.3). */}
        <span className="sr-only" aria-live="polite">
          {needsYou > 0
            ? `${needsYou} session${needsYou === 1 ? " needs" : "s need"} your permission`
            : ""}
        </span>
        {actionError && (
          <div className="fleet-error" role="alert">
            <span className="fleet-error-text">{actionError}</span>
            <button
              className="fleet-error-dismiss"
              aria-label="Dismiss this error"
              onClick={() => setActionError(null)}
            >
              ✕
            </button>
          </div>
        )}
        <div className="fleet-list">
          {ordered.map((s) => {
            const perm = s.permissions?.[0];
            const morePerms = (s.permissions?.length ?? 0) - 1;
            return (
              // A wrapper per session (M.3): the classic row plus its
              // cockpit sub-lines — the pending-permission line and the
              // quick-prompt line — so the row's stretched click-overlay
              // (.fleet-link::after, bounded by .fleet-row's position)
              // never covers the sub-line controls.
              <div key={s.sessionId} className="fleet-item">
                {/* A.3b: the row is a plain container, NOT an anchor — buttons
                    inside a link are invalid HTML and made screen readers read the
                    whole row (id, status, "end") as one link label. The session
                    NAME is the link; its stretched overlay (.fleet-link::after)
                    keeps click-anywhere-to-open for mouse users, and the real
                    controls ride above the overlay.
                    The cwd stays OFF the row (an on-row column was tried
                    2026-07-22 and re-removed the same day as clutter — Kyle):
                    desktop gets it on hover here; phone gets it in the settings
                    card's Session section, one tap inside. */}
                <div className="fleet-row" title={tildify(s.cwd, daemon.home)}>
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
                  {/* Agent before model, matching the in-session status bar (2026-07-17, Kyle);
                      model only when known, like the bar (2026-07-23). */}
                  <span className="fleet-agent">{s.agent}</span>
                  {s.model && (
                    <span className="fleet-model" title="model">
                      {s.model}
                    </span>
                  )}
                  {s.activity && (
                    <span className="fleet-activity" title="current activity">
                      {activityText(s.activity)}
                    </span>
                  )}
                  <span className="fleet-spacer" />
                  {s.usage && (
                    <span className="fleet-usage" title="session tokens · cost">
                      {fmtTokens(s.usage.inputTokens + s.usage.outputTokens)} tok
                      {s.usage.costUsd !== undefined ? ` · $${s.usage.costUsd.toFixed(2)}` : ""}
                    </span>
                  )}
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
                    className={
                      "fleet-prompt-toggle" + (promptFor === s.sessionId ? " fleet-prompt-toggle-open" : "")
                    }
                    title="Send a prompt to this session"
                    aria-label={`Send a prompt to session ${s.name}`}
                    aria-expanded={promptFor === s.sessionId}
                    onClick={() => setPromptFor(promptFor === s.sessionId ? null : s.sessionId)}
                  >
                    ❯
                  </button>
                  {s.status === "working" && (
                    <button
                      className={"fleet-stop" + (confirmStop === s.sessionId ? " fleet-stop-armed" : "")}
                      title={
                        confirmStop === s.sessionId
                          ? "Click again to interrupt this turn"
                          : "Interrupt this turn (the session stays warm)"
                      }
                      aria-label={
                        confirmStop === s.sessionId
                          ? `Click again to interrupt session ${s.name}`
                          : `Interrupt session ${s.name}`
                      }
                      onClick={() => {
                        if (confirmStop === s.sessionId) {
                          socket.send({ type: "interrupt_session", sessionId: s.sessionId });
                          stopConfirm.disarm();
                        } else {
                          stopConfirm.arm(s.sessionId);
                        }
                      }}
                    >
                      {confirmStop === s.sessionId ? "stop?" : "stop"}
                    </button>
                  )}
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
                {perm && (
                  // The "act here" line (M.3): WHAT the session wants, inert
                  // plain text, answerable in place. Oldest first, exactly
                  // like the in-session permission bar.
                  <div className="fleet-perm">
                    <span className="fleet-perm-detail" title={`${perm.tool} · ${perm.detail}`}>
                      {perm.tool} · {perm.detail}
                    </span>
                    {morePerms > 0 && <span className="fleet-perm-more">+{morePerms} more</span>}
                    <button
                      className="fleet-perm-allow"
                      disabled={answered.has(perm.id)}
                      aria-label={`Allow ${perm.tool} in session ${s.name}`}
                      onClick={() => answerPermission(s.sessionId, perm.id, true)}
                    >
                      allow
                    </button>
                    <button
                      className="fleet-perm-deny"
                      disabled={answered.has(perm.id)}
                      aria-label={`Deny ${perm.tool} in session ${s.name}`}
                      onClick={() => answerPermission(s.sessionId, perm.id, false)}
                    >
                      deny
                    </button>
                  </div>
                )}
                {promptFor === s.sessionId && (
                  <div className="fleet-prompt">
                    <span className="glyph" aria-hidden="true">
                      ❯
                    </span>
                    <input
                      className="fleet-prompt-input"
                      autoFocus
                      spellCheck={false}
                      placeholder="send a prompt to this session…"
                      aria-label={`Prompt for session ${s.name}`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") sendQuickPrompt(s.sessionId, e.currentTarget.value);
                        else if (e.key === "Escape") setPromptFor(null);
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
