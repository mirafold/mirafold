import type { AgentName } from "@protocol";

// P.4: the shell-owned onboarding picker. No agent is assumed — first run is
// "choose your agent." Credentials never reach the browser; the server tells us
// only which agents are `live` (have creds). A non-live agent still runs, in the
// API-free mock, so dev and demos work without keys.

const LABEL: Record<AgentName, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

export function Onboarding({
  agents,
  onPick,
}: {
  agents: { agent: AgentName; live: boolean }[] | null;
  onPick: (agent: AgentName) => void;
}) {
  return (
    <div className="onb-overlay">
      <div className="onb-card">
        <div className="onb-glyph">❯</div>
        <h1 className="onb-title">Choose your agent</h1>
        <p className="onb-sub">
          genui-shell re-skins the terminal agent you already use — faithfully, with
          a richer view on top.
        </p>
        <div className="onb-list">
          {agents === null ? (
            <div className="onb-connecting">connecting…</div>
          ) : (
            agents.map(({ agent, live }) => (
              <button key={agent} className="onb-agent" onClick={() => onPick(agent)}>
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
