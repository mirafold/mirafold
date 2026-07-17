import { useEffect, useState } from "react";
import type { AgentName } from "@protocol";
import { agentLabel, blockedHint, connectHint } from "../agents-meta";

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

export function Onboarding({
  agents,
  defaultCwd,
  error,
  onPick,
  onDismiss,
}: {
  agents: { agent: AgentName; live: boolean; blocked?: boolean; detail?: string }[] | null;
  defaultCwd?: string;
  error?: string | null;
  onPick: (agent: AgentName, cwd?: string) => void;
  // Present only when there's something to go back to (an existing fleet) —
  // then a click outside the card, or Esc, changes your mind (2026-07-16).
  // Absent on first run / a sessionless shell, where dismissing would leave
  // a dead page.
  onDismiss?: () => void;
}) {
  const [cwd, setCwd] = useState("");
  // The daemon cwd arrives async (agents hello) — prefill once, but never
  // clobber something the user already typed.
  useEffect(() => {
    if (defaultCwd) setCwd((c) => c || defaultCwd);
  }, [defaultCwd]);

  // Same dismiss idiom as the settings card: backdrop click + Escape.
  useEffect(() => {
    if (!onDismiss) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className="onb-overlay" onClick={onDismiss}>
      <div className="onb-card" onClick={(e) => e.stopPropagation()}>
        <img className="onb-glyph" src="/logo.svg" alt="Mirafold" />
        <h1 className="onb-title">Choose your agent</h1>
        <p className="onb-sub">
          Mirafold re-skins the terminal agent you already use — faithfully, with
          a richer view on top.
        </p>
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
        <div className="onb-list">
          {agents === null ? (
            <div className="onb-connecting">connecting…</div>
          ) : (
            agents.map(({ agent, live, blocked, detail }) => {
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
                  onClick={() => onPick(agent, cwd.trim() || undefined)}
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
        {/* R.4k: local/open models are a first-class choice, not a fourth agent
            — they're a mode of Claude Code or Codex. Say so plainly so the
            "fully local" promise is visible on the screen a local user lands on. */}
        <p className="onb-local-note">
          Running a local/open model (Ollama, LM Studio, vLLM)? It's a full
          choice here, not just the cloud agents — point Claude Code or Codex at
          it (see <code>docs/local-models.md</code>).
        </p>
      </div>
    </div>
  );
}
