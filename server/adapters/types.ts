import type { WireMsg } from "../protocol";

/**
 * The agent-adapter seam. genui-shell re-skins whichever terminal coding
 * agent you already drive; behind this interface each agent runs its **own**
 * engine and normalizes its event stream into `WireMsg` — everything
 * downstream (wire protocol, output zone, security, generative UI) consumes
 * `WireMsg` and nothing else, so a new agent is one adapter, not a rewrite.
 * No agent is privileged; no generic homegrown loop lives behind here.
 */
export interface AgentSession {
  pushPrompt(text: string): void;
  onMessage(cb: (msg: WireMsg) => void): void;
  /** Halt the in-flight turn; the session stays warm for the next prompt. */
  interrupt(): void;
  /** The browser's answer to a permission_request (Phase T.3). */
  resolvePermission(id: string, allow: boolean): void;
  close(): void;
}

/** The terminal agents genui-shell can re-skin (one adapter each). */
export type AgentName = "claude-code" | "codex" | "gemini-cli";

/**
 * Which agent a session runs, resolved once from config (never hardcoded).
 * `live` is false when the chosen agent has no credentials configured — the
 * server then substitutes the `MockSession` stand-in for API-free dev.
 * Per-agent credentials/endpoint are read from the environment by each
 * adapter and stay server-side; a `Backend` is never serialized to the wire.
 */
export type Backend = {
  agent: AgentName;
  live: boolean;
  model?: string;
};

// How long a permission prompt waits for the browser before denying.
// Overridable for tests; deny-by-default is the security posture. Neutral
// policy shared by every adapter.
export const PERMISSION_TIMEOUT_MS = Number(process.env.PERMISSION_TIMEOUT_MS ?? 60_000);

// Cap a tool result before it hits the wire and the replay buffer. Byte-
// based (not char count) because the buffer's memory cost is bytes, and
// honest: the elided amount is reported so the client marks it, never a
// silent cut. Env-overridable (tuning; also lets tests trip it on demand).
// Agent-neutral — any adapter's tool output flows through it.
const OUTPUT_CAP_BYTES = Number(process.env.TOOL_OUTPUT_CAP_BYTES ?? 64_000);

export function capOutput(text: string): { text: string; truncatedBytes?: number } {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= OUTPUT_CAP_BYTES) return { text };
  // Decode a byte-bounded slice; a trailing partial char becomes U+FFFD.
  const kept = new TextDecoder().decode(Buffer.from(text, "utf8").subarray(0, OUTPUT_CAP_BYTES));
  return { text: kept, truncatedBytes: total - OUTPUT_CAP_BYTES };
}

/** One entry of the live checklist component (T2.5); adapter-neutral shape. */
export type TodoItem = { content: string; status: "pending" | "in_progress" | "completed" };
