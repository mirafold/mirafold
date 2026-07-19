import type { AgentName, WireMsg } from "../protocol";
import type { CredentialKind } from "../provider-policy";

export type { AgentName } from "../protocol";

/**
 * The agent-adapter seam. Mirafold re-skins whichever terminal coding
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
  /** Current best-known model label, for the fleet row / status bar. Known
   *  at construction from config/DEFAULT_MODEL; may refine after the first turn
   *  for agents whose real model only appears mid-stream (Claude, Gemini) (#6). */
  readonly modelName: string;
  close(): void;
}

/**
 * Which agent a session runs, resolved once from config (never hardcoded).
 * `live` is false when the chosen agent has no credentials configured — the
 * server then substitutes the `MockSession` stand-in for API-free dev.
 * Per-agent credentials/endpoint are read from the environment by each
 * adapter and stay server-side; a `Backend` is never serialized to the wire.
 */
export type Backend = {
  agent: AgentName;
  // Which kind of credential drives this session — the input to the
  // per-provider relay policy (`provider-policy.ts`). Read by the relay gate to
  // refuse subscription-backed sessions over the paid path (R.4i).
  kind: CredentialKind;
  live: boolean;
  model?: string;
  // N.5: the chosen DISCOVERED local server (picker second step). Absent for
  // kind `local` means the env-configured endpoint, exactly as before.
  endpoint?: string;
  // The chosen config-declared provider (codex `[model_providers.<id>]`) —
  // the adapter forces it per-session so the pick's label stays true.
  provider?: string;
};

/** process.env minus `keys` (and minus undefined slots) — the per-session
 *  engine env override that WITHHOLDS a credential (N.5). Both SDKs stop
 *  inheriting once `env` is passed, so the override must carry the full
 *  environment, not just the changed vars. */
export function envWithout(...keys: string[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined && !keys.includes(e[0]),
    ),
  );
}

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

/** Flatten an SDK/MCP content-block array to transcript text: text blocks
 *  joined by newline, anything else as a `[type]` placeholder. */
export function joinTextBlocks(blocks: unknown[]): string {
  return blocks
    .map((b) => {
      const block = b as { type?: unknown; text?: unknown } | null;
      return block?.type === "text" ? String(block.text) : `[${String(block?.type ?? "block")}]`;
    })
    .join("\n");
}

// The one human-salient argument of a tool call, for the transcript line.
// Ordered: the first key present wins (Bash → command, Read → file_path, …).
const DETAIL_KEYS = ["command", "file_path", "pattern", "url", "query", "description", "path"];

export function toolDetail(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v) return v;
  }
  const json = JSON.stringify(rec);
  return json === "{}" ? undefined : json.slice(0, 160);
}
