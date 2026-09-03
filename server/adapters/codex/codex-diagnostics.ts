import { scrubSelectedEndpoint } from "../../log";
import { errText } from "../types";

export function codexProviderDiagnostic(value: unknown, endpoint?: string): string {
  return scrubSelectedEndpoint(typeof value === "string" ? value : errText(value), endpoint);
}

/** Configured providers retain Codex's own diagnostic. Only a
 * Mirafold-discovered local endpoint gets the concrete server recovery step. */
export function codexTurnDiagnostic(
  value: unknown,
  endpoint: string | undefined,
  discoveredLocalEndpoint: boolean,
): string {
  const diagnostic = codexProviderDiagnostic(value, endpoint);
  return discoveredLocalEndpoint
    ? `Local Codex could not complete the turn: ${diagnostic}. ` +
        "Check that the local model server is running and still serves the selected model."
    : diagnostic;
}

export function codexLocalTurnTimeoutDiagnostic(
  timeoutMs: number,
  effort: string,
): string {
  const seconds = Math.ceil(timeoutMs / 1_000);
  const reasoningAction =
    effort === "none"
      ? "Reasoning is already disabled; choose a faster model or machine"
      : "Send `/effort none` and retry if the server supports reasoning control, choose a faster model or machine";
  return (
    `The local Codex turn did not finish within ${seconds} seconds. ` +
    "The engine may still be pre-filling Codex's context, or the model may be reasoning too slowly. " +
    `${reasoningAction}, or raise MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS ` +
    "(set it to 0 to disable the limit)."
  );
}
