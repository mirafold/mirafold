import { useEffect, useState } from "react";
import type { AgentBackend, AgentName, BackendChoice } from "@protocol";
import {
  agentLabel,
  backendLabel,
  blockedHint,
  connectHint,
  localCapable,
  subscriptionCaveat,
  LOCAL_LIVE_HINT,
} from "../agents-meta";
import { useEscapeKey } from "../use-escape";

// The shell-owned onboarding picker. No agent is assumed — first run is
// "choose your agent." Credentials never reach the browser; the server tells us
// only which agents are `live` (have creds). A non-live agent still runs, in the
// API-free mock, so dev and demos work without keys (P.4).
// A working-directory field beside the picker — prefilled with the dir the
// daemon was launched from (terminal parity), editable to point a session
// anywhere. The server rejects a path that doesn't exist; `error` is that
// rejection, shown here so the user can fix the path and retry (4.8).
// A credential-less row carries the one-line fix (login command or env
// var) instead of a bare badge — the picker itself says what to set or run (R.4b).
// N.4: the SECOND STEP. When a clicked agent has a genuine choice of backing
// (two credentials, or a discovered local server whose model must be picked),
// the card flips to that agent's backend menu instead of creating immediately:
// usable options as buttons, a present-but-prohibited subscription VISIBLE but
// gray with the why (never hidden), the codex subscription with its
// disclosed-uncertainty caveat inline, and each discovered local server with
// its model catalog — picking a model picks the backend. While the card is
// open, `onRefresh` polls the daemon (refresh_agents → re-probe → fresh
// hello), so a just-started local server appears without a reload.

type AgentRow = {
  agent: AgentName;
  live: boolean;
  blocked?: boolean;
  detail?: string;
  backends?: AgentBackend[];
};

// How often the open picker asks the daemon to re-probe local servers (N.3's
// refresh_agents; server-side throttled independently).
const REFRESH_POLL_MS = 3_000;

/** A second step only when there's a genuine choice: more than one usable way
 *  to run, or a discovered server whose model must be picked. A single usable
 *  backend (or none — the demo path) keeps today's one-click create. */
export function needsSecondStep(row: AgentRow): boolean {
  const usable = (row.backends ?? []).filter((b) => b.usable);
  return usable.length > 1 || usable.some((b) => (b.models?.length ?? 0) > 0);
}

/** The create-request form of an advertised backend (labels only, no secret). */
function choiceOf(b: AgentBackend, model?: string): BackendChoice {
  return {
    kind: b.kind,
    ...(b.endpoint ? { endpoint: b.endpoint } : {}),
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

export function Onboarding({
  agents,
  defaultCwd,
  error,
  onPick,
  onRefresh,
  onDismiss,
}: {
  agents: AgentRow[] | null;
  defaultCwd?: string;
  error?: string | null;
  onPick: (agent: AgentName, cwd?: string, backend?: BackendChoice) => void;
  // Ask the daemon to re-probe local servers and re-send the hello (N.3);
  // called on a slow poll while the card is open.
  onRefresh?: () => void;
  // Present only when there's something to go back to (an existing fleet) —
  // then a click outside the card, or Esc, changes your mind (2026-07-16).
  // Absent on first run / a sessionless shell, where dismissing would leave
  // a dead page.
  onDismiss?: () => void;
}) {
  const [cwd, setCwd] = useState("");
  // Which agent's backend menu is open (the second step), if any.
  const [picking, setPicking] = useState<AgentName | null>(null);
  // The daemon cwd arrives async (agents hello) — prefill once, but never
  // clobber something the user already typed.
  useEffect(() => {
    if (defaultCwd) setCwd((c) => c || defaultCwd);
  }, [defaultCwd]);

  // The live "it will show here" promise: poll while open. The hello is
  // re-sent whole, so rows update in place (including mid-second-step).
  useEffect(() => {
    if (!onRefresh) return;
    const t = setInterval(onRefresh, REFRESH_POLL_MS);
    return () => clearInterval(t);
  }, [onRefresh]);

  // Same dismiss idiom as the settings card: backdrop click + Escape — but
  // with the second step open, Esc/backdrop first steps back to the agent
  // list (dismissing the whole card from there would eat the "wrong agent"
  // correction).
  const stepBack = picking ? () => setPicking(null) : onDismiss;
  useEscapeKey(stepBack);

  const pickingRow = picking ? agents?.find((a) => a.agent === picking) : undefined;
  const pick = (agent: AgentName, backend?: BackendChoice) =>
    onPick(agent, cwd.trim() || undefined, backend);

  return (
    <div className="onb-overlay" onClick={stepBack}>
      <div className="onb-card" onClick={(e) => e.stopPropagation()}>
        <img className="onb-glyph" src="/logo.svg" alt="Mirafold" />
        <h1 className="onb-title">
          {pickingRow ? `${agentLabel(pickingRow.agent)} — pick its backing` : "Choose your agent"}
        </h1>
        {!pickingRow && (
          <p className="onb-sub">
            Mirafold re-skins the terminal agent you already use — faithfully, with
            a richer view on top.
          </p>
        )}
        <label className="onb-cwd-label" htmlFor="onb-cwd">
          working directory
        </label>
        <input
          id="onb-cwd"
          className="onb-cwd"
          type="text"
          value={cwd}
          spellCheck={false}
          placeholder={defaultCwd ?? "~/path/to/project"}
          onChange={(e) => setCwd(e.target.value)}
        />
        {error && <div className="onb-error">{error}</div>}
        {pickingRow ? (
          <div className="onb-backends">
            <button className="onb-back" onClick={() => setPicking(null)}>
              ← all agents
            </button>
            {(pickingRow.backends ?? []).map((b, i) =>
              b.models?.length ? (
                // A discovered local server: its catalog IS the buttons —
                // picking a model picks the backend.
                <div className="onb-server" key={`s${i}`}>
                  <span className="onb-server-name">
                    {b.runtime ?? "local server"} · {b.endpoint ? hostOf(b.endpoint) : "local"}
                  </span>
                  <div className="onb-models">
                    {b.models.map((m) => (
                      <button
                        key={m}
                        className="onb-model"
                        onClick={() => pick(pickingRow.agent, choiceOf(b, m))}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                // A credential (or env-endpoint) row. Prohibited subscriptions
                // stay VISIBLE but gray with the why — never hidden (R.4l (c)).
                <button
                  key={`b${i}`}
                  className={`onb-backend${b.usable ? "" : " onb-backend-blocked"}`}
                  disabled={!b.usable}
                  onClick={() => pick(pickingRow.agent, choiceOf(b))}
                >
                  <span className="onb-backend-name">
                    {backendLabel(pickingRow.agent, b.kind)}
                  </span>
                  {b.detail && <span className="onb-backend-detail">{b.detail}</span>}
                  {b.usable && b.kind === "subscription" && subscriptionCaveat(pickingRow.agent) && (
                    <span className="onb-backend-caveat">
                      {subscriptionCaveat(pickingRow.agent)}
                    </span>
                  )}
                  {!b.usable && (
                    <span className="onb-backend-caveat">{blockedHint(pickingRow.agent)}</span>
                  )}
                </button>
              ),
            )}
            {localCapable(pickingRow.agent) &&
              !(pickingRow.backends ?? []).some((b) => b.models?.length) && (
                <p className="onb-live-hint">{LOCAL_LIVE_HINT}</p>
              )}
          </div>
        ) : (
          <div className="onb-list">
            {agents === null ? (
              <div className="onb-connecting">connecting…</div>
            ) : (
              agents.map((row) => {
                const { agent, live, blocked, detail } = row;
                // Three states. live → ready. blocked → a prohibited
                // subscription is present; say so and name the API-key fix (still
                // clickable — it runs the demo, like any non-live agent). none →
                // no credentials · demo (R.4i).
                const hint = blocked ? blockedHint(agent) : !live ? connectHint(agent) : undefined;
                const statusText = live
                  ? "ready"
                  : blocked
                    ? "subscription not supported"
                    : "no credentials · demo";
                const statusClass = live ? "onb-live" : blocked ? "onb-blocked" : "onb-demo";
                return (
                  <button
                    key={agent}
                    className="onb-agent"
                    onClick={() => {
                      // N.4: a genuine choice of backing opens the second
                      // step; a single usable backend (or the demo path)
                      // creates in one click, exactly as before.
                      if (needsSecondStep(row)) {
                        setPicking(agent);
                        return;
                      }
                      const only = (row.backends ?? []).find((b) => b.usable);
                      pick(agent, only ? choiceOf(only) : undefined);
                    }}
                  >
                    <span className="onb-agent-row">
                      <span className="onb-agent-name">{agentLabel(agent)}</span>
                      <span className={`onb-agent-status ${statusClass}`}>{statusText}</span>
                    </span>
                    {/* R.4k: a live agent shows what's behind it (local endpoint
                        or configured model), so a local-model user isn't left
                        guessing whether their setup was picked up. */}
                    {live && detail && <span className="onb-agent-detail">{detail}</span>}
                    {hint && <span className="onb-agent-hint">{hint}</span>}
                  </button>
                );
              })
            )}
          </div>
        )}
        {/* R.4k/N.4: local/open models are a first-class choice, not a fourth
            agent — they're a mode of Claude Code or Codex, and since N.3 a
            running server is DISCOVERED and appears in the picker live. */}
        {!pickingRow && <p className="onb-local-note">{LOCAL_LIVE_HINT}</p>}
      </div>
    </div>
  );
}
