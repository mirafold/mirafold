import { useEffect, useState } from "react";
import type { SessionMeta } from "@protocol";
import { cockpitPreviewText } from "../cockpit-preview";
import { cockpitOrder } from "../fleet-order";
import { sessionPath } from "../session-url";
import { useArmedConfirm } from "../use-armed-confirm";
import { SocketClient } from "../ws";
import { ArmedButton } from "./ArmedButton";

function retainLiveSession(sessionId: string | null, live: ReadonlySet<string>): string | null {
  return sessionId && live.has(sessionId) ? sessionId : null;
}

function toggleSession(current: string | null, sessionId: string): string | null {
  return current === sessionId ? null : sessionId;
}

export function CockpitPanel({ currentSessionId }: { currentSessionId?: string }) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionNote, setConnectionNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcriptFor, setTranscriptFor] = useState<string | null>(null);
  const [promptFor, setPromptFor] = useState<string | null>(null);
  const stopConfirm = useArmedConfirm<string>();
  const endConfirm = useArmedConfirm<string>();

  // A fleet watcher is deliberately a second connection: the session bus
  // remains attached to this transcript while the panel observes and acts on
  // every session by id. It does not inflate any session's viewport count.
  const [socket] = useState(() => {
    const next = new SocketClient();
    next.setHello(() => ({ type: "watch_sessions", transcript: true }));
    return next;
  });

  useEffect(() => {
    const offMessage = socket.onMessage((message) => {
      if (message.type === "sessions") {
        setSessions(message.sessions);
        const live = new Set(message.sessions.map((session) => session.sessionId));
        setTranscriptFor((id) => retainLiveSession(id, live));
        setPromptFor((id) => retainLiveSession(id, live));
      } else if (message.type === "error") {
        setError(message.message);
      }
    });
    const offOpen = socket.onOpen(() => {
      setConnected(true);
      setConnectionNote(null);
    });
    const offClose = socket.onClose((refusal) => {
      setConnected(false);
      setConnectionNote(refusal ?? null);
    });
    return () => {
      offMessage();
      offOpen();
      offClose();
      socket.close();
    };
  }, [socket]);

  const sendPrompt = (sessionId: string, text: string) => {
    if (text.trim()) socket.send({ type: "prompt_session", sessionId, text });
    setPromptFor(null);
  };

  const ordered = cockpitOrder(sessions ?? []);

  return (
    <aside className="cockpit-panel" aria-label="Cockpit">
      <header className="cockpit-panel-head">
        <h2>Cockpit</h2>
        <span className={`cockpit-connection ${connected ? "is-connected" : ""}`} aria-hidden="true" />
        <span className="cockpit-count">
          {sessions === null ? "…" : sessions.length}
        </span>
      </header>
      {connectionNote && (
        <div className="cockpit-error" role="alert">
          <span>{connectionNote}</span>
        </div>
      )}
      {error && (
        <div className="cockpit-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss cockpit error">
            ✕
          </button>
        </div>
      )}
      <div className="cockpit-list" role="list" aria-label="Live sessions" tabIndex={0}>
        {sessions !== null && sessions.length === 0 && (
          <p className="cockpit-empty">No live sessions.</p>
        )}
        {ordered.map((session) => (
          <CockpitRow
            key={session.sessionId}
            session={session}
            current={session.sessionId === currentSessionId}
            transcriptOpen={transcriptFor === session.sessionId}
            promptOpen={promptFor === session.sessionId}
            stopConfirm={stopConfirm}
            endConfirm={endConfirm}
            onToggleTranscript={() => {
              setTranscriptFor((id) => toggleSession(id, session.sessionId));
            }}
            onTogglePrompt={() => {
              setPromptFor((id) => toggleSession(id, session.sessionId));
            }}
            onStop={() => socket.send({ type: "interrupt_session", sessionId: session.sessionId })}
            onEnd={() => socket.send({ type: "end_session", sessionId: session.sessionId })}
            onPrompt={(text) => sendPrompt(session.sessionId, text)}
          />
        ))}
      </div>
    </aside>
  );
}

type CockpitRowProps = {
  session: SessionMeta;
  current: boolean;
  transcriptOpen: boolean;
  promptOpen: boolean;
  stopConfirm: ReturnType<typeof useArmedConfirm<string>>;
  endConfirm: ReturnType<typeof useArmedConfirm<string>>;
  onToggleTranscript: () => void;
  onTogglePrompt: () => void;
  onStop: () => void;
  onEnd: () => void;
  onPrompt: (text: string) => void;
};

function CockpitRow({
  session,
  current,
  transcriptOpen,
  promptOpen,
  stopConfirm,
  endConfirm,
  onToggleTranscript,
  onTogglePrompt,
  onStop,
  onEnd,
  onPrompt,
}: CockpitRowProps) {
  return (
    <div
      className={`cockpit-item${current ? " is-current" : ""}`}
      role="listitem"
      data-session-id={session.sessionId}
    >
      <div className="cockpit-session-line">
        <a
          className="cockpit-session-name"
          href={sessionPath(session.sessionId)}
          title={session.name}
          aria-current={current ? "page" : undefined}
        >
          {session.name}
        </a>
        <button
          className={`cockpit-disclosure cockpit-transcript-toggle${transcriptOpen ? " is-open" : ""}`}
          title="Show the latest transcript text"
          aria-label={`${transcriptOpen ? "Hide" : "Show"} transcript preview for session ${session.name}`}
          aria-expanded={transcriptOpen}
          onClick={onToggleTranscript}
        >
          <span aria-hidden="true">❯</span>
        </button>
        <button
          className={`cockpit-disclosure cockpit-prompt-toggle${promptOpen ? " is-open" : ""}`}
          title="Send the next prompt"
          aria-label={`${promptOpen ? "Hide" : "Open"} prompt input for session ${session.name}`}
          aria-expanded={promptOpen}
          onClick={onTogglePrompt}
        >
          <span aria-hidden="true">❯</span>
        </button>
      </div>
      <div className="cockpit-action-line">
        <span className="cockpit-session-id" title="session id">
          {session.sessionId}
        </span>
        {session.status !== "idle" && (
          <ArmedButton
            className="cockpit-stop"
            verb="stop"
            armed={stopConfirm.armed === session.sessionId}
            title="Stop active model and shell work (the session stays warm)"
            armedTitle="Click again to stop active model and shell work"
            ariaLabel={`Stop active model and shell work in session ${session.name}`}
            armedAriaLabel={`Click again to stop active model and shell work in session ${session.name}`}
            onArm={() => stopConfirm.arm(session.sessionId)}
            onFire={() => {
              onStop();
              stopConfirm.disarm();
            }}
          />
        )}
        <ArmedButton
          className="cockpit-end"
          verb="end"
          armed={endConfirm.armed === session.sessionId}
          title="End this session"
          armedTitle="Click again to end this session"
          ariaLabel={`End session ${session.name}`}
          armedAriaLabel={`Click again to end session ${session.name}`}
          onArm={() => endConfirm.arm(session.sessionId)}
          onFire={() => {
            onEnd();
            endConfirm.disarm();
          }}
        />
      </div>
      {transcriptOpen && (
        <div
          className="cockpit-transcript"
          role="region"
          aria-label={`Latest transcript text for session ${session.name}`}
          tabIndex={0}
        >
          {session.transcriptTail?.truncated && (
            <span className="cockpit-transcript-cut">… earlier transcript omitted</span>
          )}
          <span className="cockpit-transcript-text">
            {cockpitPreviewText(session.transcriptTail)}
          </span>
        </div>
      )}
      {promptOpen && (
        <QuickPrompt name={session.name} onSubmit={onPrompt} onClose={onTogglePrompt} />
      )}
    </div>
  );
}

function QuickPrompt({
  name,
  onSubmit,
  onClose,
}: {
  name: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="cockpit-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(text);
      }}
    >
      <span aria-hidden="true">❯</span>
      <input
        autoFocus
        value={text}
        spellCheck={false}
        placeholder="next prompt…"
        aria-label={`Prompt for session ${name}`}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
    </form>
  );
}
