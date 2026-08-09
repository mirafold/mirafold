import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentInfo, SessionMeta } from "@protocol";
import { Onboarding } from "./Onboarding";
import { ArmedButton } from "./ArmedButton";
import { ConnectDevice, type RelayInfo } from "./ConnectDevice";
import { GearGlyph } from "./GearGlyph";
import { SocketClient } from "../ws";
import { tildify } from "../tildify";
import { useArmedConfirm } from "../use-armed-confirm";
import { paintTabStatus } from "../tab-status";
import { createFolderPickerRequests } from "../folder-picker-requests";

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
 *  "✳ thinking", the gear glyph ahead of a tool label, and a bang label
 *  ("! cmd") kept as-is. */
function ActivityLine({ a }: { a: NonNullable<SessionMeta["activity"]> }) {
  const thinking = a.label === "thinking";
  const isTool = !thinking && !a.label.startsWith("! ");
  return (
    <>
      {isTool && (
        <>
          <GearGlyph size="1em" />{" "}
        </>
      )}
      {thinking ? "✳ thinking" : a.label} · {elapsed(a.since)}
    </>
  );
}

const STATUS_LABEL = { idle: "idle", working: "working", permission: "needs you" } as const;

/** A session that wants an answer: the stream-derived permission hold, OR a
 *  still-pending ask surviving past it — with concurrent requests, answering
 *  the first lets the stream move (status "working") while the rest wait. */
function wantsAnswer(s: SessionMeta): boolean {
  return s.status === "permission" || (s.permissions?.length ?? 0) > 0;
}

/** Cockpit ordering (Kyle's call, Phase M): rows hold a stable creation
 *  order so eyes can park on a session; the one exception is sessions
 *  awaiting permission, which surface to a top group — longest-stalled
 *  first (their stream is blocked, so lastActivity is when they stalled).
 *  `createdAt` is optional on the wire (old daemon); absent → the wire
 *  order holds (the sort is stable). */
function cockpitOrder(sessions: SessionMeta[]): SessionMeta[] {
  const rank = (s: SessionMeta) => (wantsAnswer(s) ? 0 : 1);
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
    folderPicker?: boolean;
    // The agents hello's relay info (protocol.ts) — RelayInfo mirrors its
    // shape, `ws` included (static-origin serving).
    relay?: RelayInfo;
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
  const stopConfirm = useArmedConfirm<string>();
  // Permission ids already answered from the grid — buttons disable
  // instantly; the next snapshot (queue dropped server-side) prunes them.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // SessionId whose quick-prompt line is open (one at a time).
  const [promptFor, setPromptFor] = useState<string | null>(null);
  // SessionId whose details sub-line is open (one at a time, like promptFor):
  // the row's volatile extras — live activity, tokens · cost — live behind
  // the down-caret disclosure instead of crowding the bar (2026-07-24, Kyle).
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [, setTick] = useState(0); // re-render so ago/elapsed labels stay honest

  // useState's lazy initializer, NOT useMemo — same reason as Shell's bus:
  // Fast Refresh re-runs useMemo on every hot edit, leaking a socket each
  // time; state survives the hot update (2026-07-25).
  const [socket] = useState(() => {
    const s = new SocketClient();
    s.setHello(() => ({ type: "watch_sessions" }));
    return s;
  });
  const [folderPicker] = useState(() =>
    createFolderPickerRequests((msg) => socket.sendIfOpen(msg)),
  );

  // The socket's message handler lives for the socket's life; it reads the
  // picker's openness through this ref so error ROUTING follows the live
  // value (picker open → its card; otherwise → the header line).
  const pickerOpenRef = useRef(false);

  useEffect(() => {
    const offMsg = socket.onMessage((m) => {
      if (folderPicker.handle(m)) return;
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
        setDaemon({ cwd: m.cwd, home: m.home, folderPicker: m.folderPicker, relay: m.relay });
      } else if (m.type === "session_created") {
        // The create issued from the onboarding card below: enter the session.
        location.assign(`/s/${m.sessionId}`);
      } else if (m.type === "error") {
        // While the picker is open its card owns errors (a refused create);
        // otherwise the reply belongs to a grid act — the header line (M.3).
        if (pickerOpenRef.current) setOnbError(m.message);
        else setActionError(m.message);
      }
    });
    const offOpen = socket.onOpen(() => setConnected(true));
    const offClose = socket.onClose(() => {
      folderPicker.disconnect();
      setConnected(false);
    });
    return () => {
      offMsg();
      offOpen();
      offClose();
      folderPicker.disconnect();
      socket.close();
    };
  }, [socket, folderPicker]);

  // Ago labels are honest at 30s; the second-resolution elapsed readout wants
  // a 1s tick — but only while something is actually active, so an idle
  // fleet page stays quiet.
  const hasLive = (sessions ?? []).some((s) => s.activity || s.status === "working");
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), hasLive ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [hasLive]);

  // M.5: the fleet TAB is a cockpit signal too — the same badge grammar as a
  // session tab (amber = something needs you, blue = fleet busy), title
  // carrying the needs-you count. paintTabStatus draws the favicon; the
  // fleet's own title overwrites its session wording.
  const needsYou = (sessions ?? []).filter(wantsAnswer).length;
  const fleetBusy = (sessions ?? []).some((s) => s.status === "working");
  useEffect(() => {
    paintTabStatus(needsYou > 0 ? "permission" : fleetBusy ? "busy" : "idle");
    document.title =
      needsYou > 0
        ? `⚠ ${needsYou} need${needsYou === 1 ? "s" : ""} you — Mirafold`
        : "Mirafold — sessions";
  }, [needsYou, fleetBusy]);

  // Stable identity: Onboarding keys its poll interval on this prop, so a
  // fresh arrow each render would restart the 3s timer instead of letting
  // it fire.
  const refreshAgents = useCallback(() => socket.send({ type: "refresh_agents" }), [socket]);
  const browseFolder = useCallback(
    (cwd?: string) => folderPicker.request(cwd),
    [folderPicker],
  );

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
  pickerOpenRef.current = onboarding;

  const ordered = cockpitOrder(sessions ?? []);

  return (
    <div className="fleet">
      {onboarding && (
        <Onboarding
          agents={agents}
          defaultCwd={tildify(daemon.cwd, daemon.home)}
          error={onbError}
          onCwdChange={() => setOnbError(null)}
          onBrowse={daemon.folderPicker ? browseFolder : undefined}
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
          {ordered.map((s) => (
            <FleetRow
              key={s.sessionId}
              s={s}
              home={daemon.home}
              renaming={renaming}
              setRenaming={setRenaming}
              commitRename={commitRename}
              detailsFor={detailsFor}
              setDetailsFor={setDetailsFor}
              promptFor={promptFor}
              setPromptFor={setPromptFor}
              stopConfirm={stopConfirm}
              endConfirm={endConfirm}
              socket={socket}
              answered={answered}
              answerPermission={answerPermission}
              sendQuickPrompt={sendQuickPrompt}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** One session's cockpit entry: the classic row plus its sub-lines. Every
 *  prop is FleetView's own state or actions, passed through under the same
 *  names — the row is presentation, the grid still owns all state. */
function FleetRow({
  s,
  home,
  renaming,
  setRenaming,
  commitRename,
  detailsFor,
  setDetailsFor,
  promptFor,
  setPromptFor,
  stopConfirm,
  endConfirm,
  socket,
  answered,
  answerPermission,
  sendQuickPrompt,
}: {
  s: SessionMeta;
  home?: string;
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  commitRename: (id: string, name: string) => void;
  detailsFor: string | null;
  setDetailsFor: (id: string | null) => void;
  promptFor: string | null;
  setPromptFor: (id: string | null) => void;
  stopConfirm: ReturnType<typeof useArmedConfirm<string>>;
  endConfirm: ReturnType<typeof useArmedConfirm<string>>;
  socket: SocketClient;
  answered: ReadonlySet<string>;
  answerPermission: (sessionId: string, id: string, allow: boolean) => void;
  sendQuickPrompt: (sessionId: string, text: string) => void;
}) {
  return (
    // A wrapper per session (M.3): the classic row plus its cockpit
    // sub-lines — the pending-permission line and the quick-prompt
    // line — so the row's stretched click-overlay
    // (.fleet-link::after, bounded by .fleet-row's position) never
    // covers the sub-line controls.
    <div className="fleet-item">
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
      <div className="fleet-row" title={tildify(s.cwd, home)}>
        <span className={`fleet-dot fleet-dot-${s.status}`} title={STATUS_LABEL[s.status]} />
        <SessionName
          s={s}
          renaming={renaming === s.sessionId}
          onStart={() => setRenaming(s.sessionId)}
          onCommit={(name) => commitRename(s.sessionId, name)}
          onCancel={() => setRenaming(null)}
        />
        {/* Agent before model, matching the in-session status bar (2026-07-17, Kyle);
            model only when known, like the bar (2026-07-23). */}
        <span className="fleet-agent">{s.agent}</span>
        {s.model && (
          <span className="fleet-model" title="model">
            {s.model}
          </span>
        )}
        <span className="fleet-spacer" />
        <span className="fleet-id" title="session id">
          {s.sessionId}
        </span>
        {/* The status WORD came off the row (2026-07-25, Kyle): the
            dot already says it — blinking blue = working. Kept for
            screen readers, which can't read a colored dot. */}
        <span className="sr-only">{STATUS_LABEL[s.status]}</span>
        <span className="fleet-ago">{ago(s.lastActivity)}</span>
        {/* M.5: who's watching — 0 is the interesting number (an
            unwatched session still working for you). */}
        <span className="fleet-viewports" title="open viewports">
          ⧉ {s.viewports}
        </span>
        <button
          className={
            "fleet-details-toggle" +
            (detailsFor === s.sessionId ? " fleet-details-toggle-open" : "")
          }
          title="Session details"
          aria-label={`${detailsFor === s.sessionId ? "Hide" : "Show"} details for session ${s.name}`}
          aria-expanded={detailsFor === s.sessionId}
          onClick={() => setDetailsFor(detailsFor === s.sessionId ? null : s.sessionId)}
        >
          {/* The ❯ glyph the prompt toggle uses, CSS-rotated to point
              down (closed) or up (open) — same icon family, not a
              lookalike triangle. */}
          <span className="fleet-details-caret" aria-hidden="true">
            ❯
          </span>
        </button>
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
          <ArmedButton
            className="fleet-stop"
            verb="stop"
            armed={stopConfirm.armed === s.sessionId}
            title="Interrupt this turn (the session stays warm)"
            armedTitle="Click again to interrupt this turn"
            ariaLabel={`Interrupt session ${s.name}`}
            armedAriaLabel={`Click again to interrupt session ${s.name}`}
            onArm={() => stopConfirm.arm(s.sessionId)}
            onFire={() => {
              socket.send({ type: "interrupt_session", sessionId: s.sessionId });
              stopConfirm.disarm();
            }}
          />
        )}
        <ArmedButton
          className="fleet-end"
          verb="end"
          armed={endConfirm.armed === s.sessionId}
          title="End this session"
          armedTitle="Click again to end this session"
          ariaLabel={`End session ${s.name}`}
          armedAriaLabel={`Click again to end session ${s.name}`}
          onArm={() => endConfirm.arm(s.sessionId)}
          onFire={() => {
            socket.send({ type: "end_session", sessionId: s.sessionId });
            endConfirm.disarm();
          }}
        />
      </div>
      <PermissionLine
        s={s}
        answered={answered}
        onAnswer={(id, allow) => answerPermission(s.sessionId, id, allow)}
      />
      {detailsFor === s.sessionId && <DetailsLine s={s} />}
      {promptFor === s.sessionId && (
        <QuickPromptLine
          name={s.name}
          onSubmit={(text) => sendQuickPrompt(s.sessionId, text)}
          onClose={() => setPromptFor(null)}
        />
      )}
    </div>
  );
}

/** The row's name slot: the session link + rename pencil, or — mid-rename —
 *  the input (Enter/blur commits, Escape cancels). */
function SessionName({
  s,
  renaming,
  onStart,
  onCommit,
  onCancel,
}: {
  s: SessionMeta;
  renaming: boolean;
  onStart: () => void;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  return renaming ? (
    <input
      className="fleet-rename"
      defaultValue={s.name}
      autoFocus
      spellCheck={false}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(e.currentTarget.value);
        else if (e.key === "Escape") onCancel();
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
        onClick={onStart}
      >
        ✎
      </button>
    </span>
  );
}

/** The "act here" sub-line (M.3): WHAT the session wants, inert plain text,
 *  answerable in place. Oldest first, exactly like the in-session permission
 *  bar; renders nothing when the queue is empty. */
function PermissionLine({
  s,
  answered,
  onAnswer,
}: {
  s: SessionMeta;
  answered: ReadonlySet<string>;
  onAnswer: (id: string, allow: boolean) => void;
}) {
  const perm = s.permissions?.[0];
  if (!perm) return null;
  const morePerms = (s.permissions?.length ?? 0) - 1;
  return (
    <div className="fleet-perm">
      <span className="fleet-perm-detail" title={`${perm.tool} · ${perm.detail}`}>
        {perm.tool} · {perm.detail}
      </span>
      {morePerms > 0 && <span className="fleet-perm-more">+{morePerms} more</span>}
      <button
        className="fleet-perm-allow"
        disabled={answered.has(perm.id)}
        aria-label={`Allow ${perm.tool} in session ${s.name}`}
        onClick={() => onAnswer(perm.id, true)}
      >
        allow
      </button>
      <button
        className="fleet-perm-deny"
        disabled={answered.has(perm.id)}
        aria-label={`Deny ${perm.tool} in session ${s.name}`}
        onClick={() => onAnswer(perm.id, false)}
      >
        deny
      </button>
    </div>
  );
}

/** The on-demand details sub-line (2026-07-24, Kyle): the row's volatile
 *  extras — live activity and tokens · cost — moved off the bar so the
 *  glance set stays stable; opened per-row by the caret disclosure, one at
 *  a time. Renders from the same snapshots as the row, so it live-updates
 *  while open. Activity text is engine-derived — inert plain text, never
 *  markdown. */
function DetailsLine({ s }: { s: SessionMeta }) {
  return (
    <div className="fleet-details">
      <span className="fleet-details-activity">
        {s.activity ? <ActivityLine a={s.activity} /> : "nothing running"}
      </span>
      {s.usage && (
        <span className="fleet-details-usage" title="session tokens · cost">
          {fmtTokens(s.usage.inputTokens + s.usage.outputTokens)} tok
          {s.usage.costUsd !== undefined ? ` · $${s.usage.costUsd.toFixed(2)}` : ""}
        </span>
      )}
    </div>
  );
}

/** The quick-prompt sub-line: one input, Enter sends, Escape closes. */
function QuickPromptLine({
  name,
  onSubmit,
  onClose,
}: {
  name: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fleet-prompt">
      <span className="glyph" aria-hidden="true">
        ❯
      </span>
      <input
        className="fleet-prompt-input"
        autoFocus
        spellCheck={false}
        placeholder="send a prompt to this session…"
        aria-label={`Prompt for session ${name}`}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit(e.currentTarget.value);
          else if (e.key === "Escape") onClose();
        }}
      />
    </div>
  );
}
