import { envWithout } from "../types";

export type GeminiCredential = "api-key" | "subscription";

// Gemini's documented settings expansion binds the choice to the CHILD,
// even when two sessions share a workspace. Terminal Gemini retains the
// adapter's previous API-key default when the Mirafold variable is absent.
export const GEMINI_AUTH_SETTING = "${MIRAFOLD_GEMINI_AUTH_TYPE:-gemini-api-key}";

export function geminiEnvironment(kind: GeminiCredential): Record<string, string> {
  return {
    ...envWithout(),
    // Empty (not absent) prevents Gemini's environment loader from adding
    // keys back. Trying a sign-in never opts the user into metered API use.
    ...(kind === "subscription" ? { GEMINI_API_KEY: "", GOOGLE_API_KEY: "" } : {}),
    MIRAFOLD_GEMINI_AUTH_TYPE: kind === "subscription" ? "oauth-personal" : "gemini-api-key",
    // Reuse an existing login. An expired login must fail with the CLI's
    // auth error, not open a browser or wait for input our stream can't send.
    ...(kind === "subscription" ? { NO_BROWSER: "true" } : {}),
    // Both callers are behind the adapter's Gemini-specific trust gate.
    GEMINI_CLI_TRUST_WORKSPACE: "true",
  };
}

export const GEMINI_SIGN_IN_FALLBACK =
  "If Gemini CLI sign-in is unavailable for your account, start a new Gemini CLI session with a Gemini API key. Set GEMINI_API_KEY (aistudio.google.com/apikey) if that option is not listed. Mirafold does not switch to API billing automatically.";
