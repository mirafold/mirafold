import { useEffect, useState } from "react";
import type { AgentName } from "@protocol";

// P.4: the shell-owned onboarding picker. No agent is assumed — first run is
// "choose your agent." Credentials never reach the browser; the server tells us
// only which agents are `live` (have creds). A non-live agent still runs, in the
// API-free mock, so dev and demos work without keys.
// 4.8: a working-directory field beside the picker — prefilled with the dir the
// daemon was launched from (terminal parity), editable to point a session
// anywhere. The server rejects a path that doesn't exist; `error` is that
// rejection, shown here so the user can fix the path and retry.

const LABEL: Record<AgentName, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

export function Onboarding({
  agents,
  defaultCwd,
  error,
  onPick,
}: {
  agents: { agent: AgentName; live: boolean }[] | null;
  defaultCwd?: string;
  error?: string | null;
  onPick: (agent: AgentName, cwd?: string) => void;
}) {
  const [cwd, setCwd] = useState("");
  // The daemon cwd arrives async (agents hello) — prefill once, but never
  // clobber something the user already typed.
  useEffect(() => {
    if (defaultCwd) setCwd((c) => c || defaultCwd);
  }, [defaultCwd]);

  return (
    <div className="onb-overlay">
      <div className="onb-card">
        <div className="onb-glyph">❯</div>
        <h1 className="onb-title">Choose your agent</h1>
        <p className="onb-sub">
          genui-shell re-skins the terminal agent you already use — faithfully, with
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
            agents.map(({ agent, live }) => (
              <button
                key={agent}
                className="onb-agent"
                onClick={() => onPick(agent, cwd.trim() || undefined)}
              >
                <span className="onb-agent-name">{LABEL[agent]}</span>
                <span className={`onb-agent-status ${live ? "onb-live" : "onb-demo"}`}>
                  {live ? "ready" : "no credentials · demo"}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
