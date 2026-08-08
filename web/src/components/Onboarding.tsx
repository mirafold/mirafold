import { useEffect, useState } from "react";
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
// N.4: the SECOND STEP (BackendMenu below). When a clicked agent has a genuine
// choice of backing, the card flips to that agent's backend menu instead of
// creating immediately. While the card is open, `onRefresh` polls the daemon
// (refresh_agents → re-probe → fresh hello), so a just-started local server
// appears without a reload.

// How often the open picker asks the daemon to re-probe local servers (N.3's
// refresh_agents; server-side throttled independently).
const REFRESH_POLL_MS = 3_000;

// Names the dialog for a screen reader (A.2b). A constant is safe: only one
// onboarding card is ever mounted.
const TITLE_ID = "onb-card-title";

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
  if (b.endpoint) return `${b.runtime ?? "local server"} · ${hostOf(b.endpoint)}`;
  if (b.kind === "local") return localBackendLabel(agent, b.detail);
  return backendLabel(agent, b.kind);
}

/** Does this row run on the user's own machine (2026-07-20)? Rows are one per
 *  DISCOVERED server, so the answer can't live in a row's name — with Ollama
 *  and LM Studio both up you'd have two rows each claiming to be "local
 *  models". It's a per-row tag instead, and it's the honest reading of the
 *  endpoint: `MIRAFOLD_LOCAL_ENDPOINTS` can point the probe at a box down the
 *  hall, which is not the free-and-private promise this tag makes. Same
 *  loopback test the server's endpointDetail() uses for BYO env rows. */
function runsOnThisMachine(b: AgentBackend): boolean {
  if (!b.endpoint) return false;
  try {
    const { hostname } = new URL(b.endpoint);
    return hostname === "localhost" || hostname === "[::1]" || hostname.startsWith("127.");
  } catch {
    return false;
  }
}

/** What model this row runs — the line that makes the rows comparable
 *  (2026-07-20). A discovered server offers a catalog, so it promises the
 *  count and defers the choice one click; every other row runs exactly one
 *  model and must say which, or say nothing when only the agent's own
 *  default applies. */
function modelLine(b: AgentBackend): string | undefined {
  const n = b.models?.length ?? 0;
  if (n) return `${n} model${n === 1 ? "" : "s"} — choose →`;
  return b.model;
}

/** N.4's second step: how the picked agent is backed — one uniform row per
 *  way to run, each naming its model. Usable credentials as buttons (the
 *  codex subscription with its disclosed-uncertainty caveat inline), a
 *  present-but-prohibited subscription VISIBLE but gray with the why (never
 *  hidden), and each discovered local server as ONE row that opens its
 *  catalog (the third step below). Before 2026-07-20 a server splayed its
 *  models inline while every other row hid its own — three rows that looked
 *  like three unrelated kinds of thing. */
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
      <div className="onb-backends">
        <button className="onb-back" onClick={() => onExpand(null)}>
          <span aria-hidden="true">← </span>all backends
        </button>
        <span className="onb-server-name">{backendName(row.agent, server)}</span>
        <div className="onb-models">
          {server.models?.map((m) => (
            <button key={m} className="onb-model" onClick={() => onChoose(choiceOf(server, m))}>
              {m}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="onb-backends">
      <button className="onb-back" onClick={onBack}>
        <span aria-hidden="true">← </span>all agents
      </button>
      {backends.map((b, i) => (
        // Prohibited subscriptions stay VISIBLE but gray with the why —
        // never hidden (R.4l (c)).
        <button
          key={`b${i}`}
          className={`onb-backend${b.usable ? "" : " onb-backend-blocked"}`}
          disabled={!b.usable}
          onClick={() =>
            b.models?.length && b.endpoint ? onExpand(b.endpoint) : onChoose(choiceOf(b))
          }
        >
          {/* Name + tag, the agent row's idiom one size down. */}
          <span className="onb-backend-row">
            <span className="onb-backend-name">{backendName(row.agent, b)}</span>
            {runsOnThisMachine(b) && <span className="onb-backend-tag">local</span>}
          </span>
          {b.kind !== "local" && b.detail && <span className="onb-backend-detail">{b.detail}</span>}
          {modelLine(b) && <span className="onb-backend-model">{modelLine(b)}</span>}
          {b.usable && b.kind === "subscription" && subscriptionCaveat(row.agent) && (
            <span className="onb-backend-caveat">{subscriptionCaveat(row.agent)}</span>
          )}
          {/* The row's own hint wins (a declared provider missing its env
              key names the exact variable); the per-agent hint covers the
              prohibited-subscription rows it was written for. */}
          {!b.usable && (
            <span className="onb-backend-caveat">{b.hint ?? blockedHint(row.agent)}</span>
          )}
        </button>
      ))}
      {/* The "configure a BYO endpoint and it shows up here" promise — shown
          only when nothing on screen already IS one. Telling a user to add
          OpenRouter to config.toml while their OpenRouter row sits directly
          above it was the single most confusing thing in this menu. */}
      {localCapable(row.agent) &&
        !backends.some((b) => b.models?.length || b.provider || b.endpoint) && (
          <p className="onb-live-hint">{localLiveHint(row.agent)}</p>
        )}
    </div>
  );
}

export function Onboarding({
  agents,
  defaultCwd,
  error,
  onPick,
  onBrowse,
  onRefresh,
  onDismiss,
}: {
  agents: AgentInfo[] | null;
  defaultCwd?: string;
  error?: string | null;
  onPick: (agent: AgentName, cwd?: string, backend?: BackendChoice) => void;
  // Present only when this LOCAL daemon advertised a host-native picker.
  // Cancel resolves undefined; errors reject and stay inside this card.
  onBrowse?: (cwd?: string) => Promise<string | undefined>;
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
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
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
  const browse = async () => {
    if (!onBrowse || browsing) return;
    setBrowseError(null);
    setBrowsing(true);
    try {
      const selected = await onBrowse(cwd.trim() || undefined);
      if (selected) setCwd(selected);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowsing(false);
    }
  };
  const shownError = browseError ?? error;

  return (
    // Esc/backdrop walk back the same steps (stepBack above), so the modal's
    // one dismiss action is the step-back here.
    <ModalCard overlayClass="onb-overlay" cardClass="onb-card" titleId={TITLE_ID} onDismiss={stepBack}>
      <img className="onb-glyph" src="/logo.svg" alt="" aria-hidden="true" />
      <h1 className="onb-title" id={TITLE_ID}>
        {pickingRow
          ? `${agentLabel(pickingRow.agent)} — ${expanded ? "pick a model" : "pick its backing"}`
          : "Choose your agent"}
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
      <div className="onb-cwd-row">
        <input
          id="onb-cwd"
          className="onb-cwd"
          type="text"
          value={cwd}
          spellCheck={false}
          placeholder={defaultCwd ?? "~/path/to/project"}
          aria-describedby={shownError ? "onb-cwd-error" : undefined}
          onChange={(e) => {
            setCwd(e.target.value);
            setBrowseError(null);
          }}
        />
        {onBrowse && (
          <button
            type="button"
            className="onb-cwd-browse"
            disabled={browsing}
            onClick={() => void browse()}
          >
            {browsing ? "choosing…" : "browse…"}
          </button>
        )}
      </div>
      {shownError && (
        <div className="onb-error" id="onb-cwd-error">
          {shownError}
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
        <div className="onb-list">
          {agents === null ? (
            <div className="onb-connecting">connecting…</div>
          ) : (
            agents.map((row) => {
              const { agent, live, blocked, kind, detail } = row;
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
              const backing = backingLine(agent, kind, detail);
              return (
                <button
                  key={agent}
                  className="onb-agent"
                  onClick={() => {
                    // N.4: a genuine choice of backing opens the second
                    // step; a single usable backend (or the demo path)
                    // creates in one click, exactly as before.
                    if (needsSecondStep(row)) {
                      setExpanded(null);
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
                      guessing whether their setup was picked up. 2026-07-20:
                      it NAMES the credential too — the row is a decision made
                      for the user when only one backend is usable, and a
                      decision made for you still has to be stated. */}
                  {live && backing && <span className="onb-agent-detail">{backing}</span>}
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
      {!pickingRow && <p className="onb-local-note">{localLiveHint()}</p>}
    </ModalCard>
  );
}
