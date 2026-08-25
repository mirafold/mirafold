import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentBackend, AgentInfo, AgentName, BackendChoice } from "@protocol";
import {
  agentLabel,
  backendLabel,
  backingLine,
  blockedHint,
  connectHint,
  localBackendLabel,
  localCapable,
  subscriptionCaveat,
  localLiveHint,
} from "../agents-meta";
import { ModalCard } from "./ModalCard";

// The shell-owned agent picker. No agent is assumed — first run is
// "choose your agent." Credentials never reach the browser; the server tells us
// only which agents are `live` (have creds). A non-live agent still runs, in the
// API-free mock, so dev and demos work without keys.
// A working-directory field beside the picker — prefilled with the dir the
// daemon was launched from (terminal parity), editable to point a session
// anywhere. The server rejects a path that doesn't exist; `error` is that
// rejection, shown here so the user can fix the path and retry.
// A credential-less row carries the one-line fix (login command or env
// var) instead of a bare badge — the picker itself says what to set or run.
// The SECOND STEP (BackendMenu below). When a clicked agent has a genuine
// choice of backing, the card flips to that agent's backend menu instead of
// creating immediately. While the card is open, `onRefresh` polls the daemon
// (refresh_agents → re-probe → fresh hello), so a just-started local server
// appears without a reload.

// How often the open picker asks the daemon to re-probe local servers
// (refresh_agents; server-side throttled independently).
const REFRESH_POLL_MS = 3_000;

// Names the dialog for a screen reader. A constant is safe: only one
// agent-picker card is ever mounted.
const TITLE_ID = "agent-picker-card-title";

function revealPathEnd(input: HTMLInputElement | null): void {
  if (input) input.scrollLeft = input.scrollWidth;
}

/** A second step only when there's a genuine choice: more than one usable way
 *  to run, or a discovered server whose model must be picked. A single usable
 *  backend (or none — the demo path) keeps today's one-click create. */
function needsSecondStep(row: AgentInfo): boolean {
  const usable = (row.backends ?? []).filter((b) => b.usable);
  return usable.length > 1 || usable.some((b) => (b.models?.length ?? 0) > 0);
}

/** The create-request form of an advertised backend (labels only, no secret). */
function choiceOf(b: AgentBackend, model?: string): BackendChoice {
  return {
    kind: b.kind,
    ...(b.endpoint ? { endpoint: b.endpoint } : {}),
    ...(b.backendId ? { backendId: b.backendId } : {}),
    ...(b.provider ? { provider: b.provider } : {}),
    ...(model ? { model } : {}),
  };
}

/** Host shown for a discovered server ("127.0.0.1:11434"). The endpoint comes
 *  from our own daemon, but parse defensively all the same. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** One row's headline. A discovered server names its runtime and host; a BYO
 *  endpoint / declared-provider row's `detail` IS its full label ("OpenRouter ·
 *  openrouter.ai"); everything else gets the credential's product name. */
function backendName(agent: AgentName, b: AgentBackend): string {
  if (b.endpoint && (b.runtime || b.models?.length)) {
    return `${b.runtime ?? "local server"} · ${hostOf(b.endpoint)}`;
  }
  if (b.kind === "local") return localBackendLabel(agent, b.detail);
  return backendLabel(agent, b.kind);
}

/** Does this row run on the user's own machine? This privacy claim comes
 * only from the daemon's exact IP classification: re-parsing a hostname in
 * the browser would treat `127.attacker.test` as local. */
function runsOnThisMachine(b: AgentBackend): boolean {
  return b.onDevice === true;
}

/** What model this row runs — the line that makes the rows comparable.
 *  A discovered server offers a catalog, so it promises the
 *  count and defers the choice one click; every other row runs exactly one
 *  model and must say which, or say nothing when only the agent's own
 *  default applies. */
function modelLine(b: AgentBackend): string | undefined {
  const n = b.models?.length ?? 0;
  if (n) return `${n} model${n === 1 ? "" : "s"} — choose →`;
  return b.model;
}

/** The second step: how the picked agent is backed — one uniform row per
 *  way to run, each naming its model. Usable credentials as buttons (the
 *  codex subscription with its disclosed-uncertainty caveat inline), a
 *  present-but-prohibited subscription VISIBLE but gray with the why (never
 *  hidden), and each discovered local server as ONE row that opens its
 *  catalog (the third step below). A server must not splay its models
 *  inline while every other row hides its own — that reads as three
 *  unrelated kinds of thing. */
function BackendMenu({
  row,
  onBack,
  onChoose,
  expanded,
  onExpand,
}: {
  row: AgentInfo;
  onBack: () => void;
  onChoose: (backend: BackendChoice) => void;
  // The endpoint of the server whose catalog is open, if any. Held by the
  // parent so Esc/backdrop steps back through it (and keyed by endpoint, not
  // index, so the open poll's re-send can't swap which server you're in).
  expanded: string | null;
  onExpand: (endpoint: string | null) => void;
}) {
  const backends = row.backends ?? [];
  // A server that stopped mid-step falls back to the list — never a dead pane.
  const server = backends.find((b) => b.endpoint === expanded && b.models?.length);
  if (server) {
    return (
      <div className="agent-picker-backends">
        <button className="agent-picker-back" onClick={() => onExpand(null)}>
          <span aria-hidden="true">← </span>all backends
        </button>
        <span className="agent-picker-server-name">{backendName(row.agent, server)}</span>
        <div className="agent-picker-models">
          {server.models?.map((m) => (
            <button key={m} className="agent-picker-model" onClick={() => onChoose(choiceOf(server, m))}>
              {m}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="agent-picker-backends">
      <button className="agent-picker-back" onClick={onBack}>
        <span aria-hidden="true">← </span>all agents
      </button>
      {backends.map((b, i) => (
        // Prohibited subscriptions stay VISIBLE but gray with the why —
        // never hidden.
        <button
          key={`b${i}`}
          className={`agent-picker-backend${b.usable ? "" : " agent-picker-backend-blocked"}`}
          disabled={!b.usable}
          onClick={() =>
            b.models?.length && b.endpoint ? onExpand(b.endpoint) : onChoose(choiceOf(b))
          }
        >
          {/* Name + tag, the agent row's idiom one size down. */}
          <span className="agent-picker-backend-row">
            <span className="agent-picker-backend-name">{backendName(row.agent, b)}</span>
            {runsOnThisMachine(b) && <span className="agent-picker-backend-tag">local</span>}
          </span>
          {b.kind !== "local" && b.detail && <span className="agent-picker-backend-detail">{b.detail}</span>}
          {modelLine(b) && <span className="agent-picker-backend-model">{modelLine(b)}</span>}
          {b.usable && b.kind === "subscription" && subscriptionCaveat(row.agent) && (
            <span className="agent-picker-backend-caveat">{subscriptionCaveat(row.agent)}</span>
          )}
          {/* The row's own hint wins (a declared provider missing its env
              key names the exact variable); the per-agent hint covers the
              prohibited-subscription rows it was written for. */}
          {!b.usable && (
            <span className="agent-picker-backend-caveat">{b.hint ?? blockedHint(row.agent)}</span>
          )}
        </button>
      ))}
      {/* The "configure a BYO endpoint and it shows up here" promise — shown
          only when nothing on screen already IS one. Telling a user to add
          OpenRouter to config.toml while their OpenRouter row sits directly
          above it was the single most confusing thing in this menu. */}
      {localCapable(row.agent) &&
        !backends.some((b) => b.models?.length || b.provider || b.endpoint || b.backendId) && (
          <p className="agent-picker-live-hint">{localLiveHint(row.agent)}</p>
        )}
    </div>
  );
}

type AgentPickerProps = {
  agents: AgentInfo[] | null;
  defaultCwd?: string;
  error?: string | null;
  onPick: (agent: AgentName, cwd?: string, backend?: BackendChoice) => void;
  // A create error describes the cwd that was submitted. Once the user
  // edits or replaces that cwd, its owner must discard the stale error.
  onCwdChange?: () => void;
  // Present only when this LOCAL daemon advertised a host-native picker.
  // Cancel resolves undefined; errors reject and stay inside this card.
  onBrowse?: (cwd?: string) => Promise<string | undefined>;
  // Ask the daemon to re-probe local servers and re-send the hello;
  // called on a slow poll while the card is open.
  onRefresh?: () => void;
  // Present only when there's something to go back to (an existing fleet) —
  // then a click outside the card, or Esc, changes your mind.
  // Absent on first run / a sessionless shell, where dismissing would leave
  // a dead page.
  onDismiss?: () => void;
};

export function AgentPicker({
  agents,
  defaultCwd,
  error,
  onPick,
  onCwdChange,
  onBrowse,
  onRefresh,
  onDismiss,
}: AgentPickerProps) {
  const [cwd, setCwd] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const cwdInput = useRef<HTMLInputElement>(null);
  // Which agent's backend menu is open (the second step), if any.
  const [picking, setPicking] = useState<AgentName | null>(null);
  // Which discovered server's model catalog is open (the third step) — its
  // endpoint, or null.
  const [expanded, setExpanded] = useState<string | null>(null);
  // The daemon cwd arrives async (agents hello) — prefill once, but never
  // clobber something the user already typed.
  useEffect(() => {
    if (defaultCwd) setCwd((c) => c || defaultCwd);
  }, [defaultCwd]);

  // A native pick replaces this controlled input while focus remains on the
  // browse button. With no caret to reveal, browsers otherwise leave the
  // input at scrollLeft 0 and show the filesystem root instead of the folder
  // that identifies the project. Keep caret-driven scrolling while editing;
  // whenever an unfocused value lands (or editing ends), reveal its leaf.
  useLayoutEffect(() => {
    const input = cwdInput.current;
    if (document.activeElement !== input) revealPathEnd(input);
  }, [cwd]);

  // The live "it will show here" promise: poll while open. The hello is
  // re-sent whole, so rows update in place (including mid-second-step).
  useEffect(() => {
    if (!onRefresh) return;
    const t = setInterval(onRefresh, REFRESH_POLL_MS);
    return () => clearInterval(t);
  }, [onRefresh]);

  // Same dismiss idiom as the settings card: backdrop click + Escape — but
  // with a later step open, Esc/backdrop first walks back one step (model
  // catalog → backends → agents; dismissing the whole card from there would
  // eat the "wrong agent" correction).
  const stepBack = expanded
    ? () => setExpanded(null)
    : picking
      ? () => setPicking(null)
      : onDismiss;

  const pickingRow = picking ? agents?.find((a) => a.agent === picking) : undefined;
  const pick = (agent: AgentName, backend?: BackendChoice) =>
    onPick(agent, cwd.trim() || undefined, backend);
  const updateCwd = (next: string) => {
    setCwd(next);
    setBrowseError(null);
    onCwdChange?.();
  };
  const browseForDirectory = async () => {
    if (!onBrowse || browsing) return;
    setBrowseError(null);
    setBrowsing(true);
    try {
      const selected = await onBrowse(cwd.trim() || undefined);
      if (selected) updateCwd(selected);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowsing(false);
    }
  };
  const currentError = browseError ?? error;

  return (
    // Esc/backdrop walk back the same steps (stepBack above), so the modal's
    // one dismiss action is the step-back here.
    <ModalCard overlayClass="agent-picker-overlay" cardClass="agent-picker-card" titleId={TITLE_ID} onDismiss={stepBack}>
      <img className="agent-picker-glyph" src="/logo.svg" alt="" aria-hidden="true" />
      <h1 className="agent-picker-title" id={TITLE_ID}>
        {pickingRow
          ? `${agentLabel(pickingRow.agent)} — ${expanded ? "pick a model" : "pick its backing"}`
          : "Choose your agent"}
      </h1>
      {!pickingRow && (
        <p className="agent-picker-sub">
          Mirafold re-skins the terminal agent you already use — faithfully, with
          a richer view on top.
        </p>
      )}
      <label className="agent-picker-cwd-label" htmlFor="agent-picker-cwd">
        working directory
      </label>
      <div className="agent-picker-cwd-row">
        <input
          ref={cwdInput}
          id="agent-picker-cwd"
          className="agent-picker-cwd"
          type="text"
          value={cwd}
          spellCheck={false}
          placeholder={defaultCwd ?? "~/path/to/project"}
          aria-describedby={currentError ? "agent-picker-cwd-error" : undefined}
          onChange={(e) => updateCwd(e.target.value)}
          onBlur={(e) => revealPathEnd(e.currentTarget)}
        />
        {onBrowse && (
          <button
            type="button"
            className="agent-picker-cwd-browse"
            disabled={browsing}
            onClick={() => void browseForDirectory()}
          >
            {browsing ? "choosing…" : "browse…"}
          </button>
        )}
      </div>
      {currentError && (
        <div className="agent-picker-error" id="agent-picker-cwd-error">
          {currentError}
        </div>
      )}
      {pickingRow ? (
        <BackendMenu
          row={pickingRow}
          onBack={() => setPicking(null)}
          onChoose={(backend) => pick(pickingRow.agent, backend)}
          expanded={expanded}
          onExpand={setExpanded}
        />
      ) : (
        <div className="agent-picker-list">
          {agents === null ? (
            <div className="agent-picker-connecting">connecting…</div>
          ) : (
            agents.map((row) => {
              const { agent, live, blocked, kind, detail } = row;
              // Three states. live → ready. blocked → a prohibited
              // subscription is present; say so and name the API-key fix (still
              // clickable — it runs the demo, like any non-live agent). none →
              // no credentials · demo.
              const hint = blocked ? blockedHint(agent) : !live ? connectHint(agent) : undefined;
              const statusText = live
                ? "ready"
                : blocked
                  ? "subscription not supported"
                  : "no credentials · demo";
              const statusClass = live ? "agent-picker-live" : blocked ? "agent-picker-blocked" : "agent-picker-demo";
              const backing = backingLine(agent, kind, detail);
              return (
                <button
                  key={agent}
                  className="agent-picker-agent"
                  onClick={() => {
                    // A genuine choice of backing opens the second
                    // step; a single usable backend (or the demo path)
                    // creates in one click.
                    if (needsSecondStep(row)) {
                      setExpanded(null);
                      setPicking(agent);
                      return;
                    }
                    const only = (row.backends ?? []).find((b) => b.usable);
                    pick(agent, only ? choiceOf(only) : undefined);
                  }}
                >
                  <span className="agent-picker-agent-row">
                    <span className="agent-picker-agent-name">{agentLabel(agent)}</span>
                    <span className={`agent-picker-agent-status ${statusClass}`}>{statusText}</span>
                  </span>
                  {/* A live agent shows what's behind it (local endpoint
                      or configured model), so a local-model user isn't left
                      guessing whether their setup was picked up. It NAMES
                      the credential too — the row is a decision made
                      for the user when only one backend is usable, and a
                      decision made for you still has to be stated. */}
                  {live && backing && <span className="agent-picker-agent-detail">{backing}</span>}
                  {hint && <span className="agent-picker-agent-hint">{hint}</span>}
                </button>
              );
            })
          )}
        </div>
      )}
      {/* Local/open models are a first-class choice, not a fourth
          agent — they're a mode of Claude Code or Codex, and a running
          server is DISCOVERED and appears in the picker live. */}
      {!pickingRow && <p className="agent-picker-local-note">{localLiveHint()}</p>}
    </ModalCard>
  );
}
