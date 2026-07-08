import type { AgentName } from "@protocol";

// R.4b: shared display metadata for the offerable agents. LABEL is the human
// name; CONNECT_HINT is the one concrete action that makes that agent live —
// shown on the onboarding picker's credential-less rows and in the in-session
// demo banner, so "no credentials" is never a dead end.

export const LABEL: Record<AgentName, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

export const CONNECT_HINT: Record<AgentName, string> = {
  "claude-code": "log in once with `claude`, or set ANTHROPIC_API_KEY in .env",
  codex: "run `codex login`, or set OPENAI_API_KEY in .env",
  "gemini-cli": "set GEMINI_API_KEY in .env (free key: aistudio.google.com/apikey)",
};
