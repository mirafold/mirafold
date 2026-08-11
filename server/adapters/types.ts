import path from "node:path";
import type { AgentName, PromptOption, WireMsg } from "../protocol";
import type { CredentialKind } from "../provider-policy";
import { locateTrustedExecutable } from "../security/executable-trust";

export type { AgentName } from "../protocol";
import { envInt } from "../env";

/** Resolve an agent executable that is actually installed outside an SDK.
 *  The env override is explicit operator intent, so return it even when it is
 *  a bare name or currently missing (the eventual spawn then fails honestly).
 *  Otherwise mirror normal command lookup: beside node first (global npm/nvm
 *  installs), then filtered PATH. Project files, relative entries, and npm's
 *  injected node_modules bins are never agent identity. `undefined` lets an
 *  SDK retain its bundled fallback. */
export function installedAgentBin(envVar: string, name: string): string | undefined {
  const override = process.env[envVar];
  if (override) return override;
  return locateTrustedExecutable(name, {
    directories: [path.dirname(process.execPath)],
  });
}

/** Resolve which `name`d agent binary to spawn. Non-SDK adapters need a
 *  command even when lookup misses so their first turn can surface ENOENT. */
export function agentBin(envVar: string, name: string): string {
  return installedAgentBin(envVar, name) ?? name;
}

/** The human-readable message of an unknown catch value. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
   *  at construction only when configured (opts.model/DEFAULT_MODEL); refines
   *  after the first turn for agents whose real model only appears mid-stream
   *  (Claude, Gemini, Codex) (#6). `undefined` = not yet known — the UI shows
   *  nothing, never a stand-in that reads as a model name (2026-07-23, Kyle). */
  readonly modelName: string | undefined;
  /** Provider-owned id that can reopen this conversation after Mirafold's
   * daemon process is gone. Undefined only until a provider assigns one. */
  readonly resumeId?: string;
  /** Some providers only make a freshly chosen id resumable after engine
   * initialization. This callback lets the registry durably capture that
   * identity at the readiness boundary instead of guessing from a later
   * unrelated wire event. */
  onResumeId?(cb: (id: string) => void): void;
  /** Re-read and emit the provider's pre-submit command/skill catalog. */
  refreshPromptOptions?(): void;
  close(): void;
}

/** Replace the browser's catalog in one atomic message. Kept here so every
 * adapter applies the same stable dedupe rule. */
export function emitPromptOptions(
  emit: (msg: WireMsg) => void,
  options: PromptOption[],
) {
  const seen = new Set<string>();
  emit({
    type: "prompt_options",
    options: options.filter((option) => {
      const key = `${option.trigger}\0${option.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  });
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
  // N.5/UX.7: the exact chosen local server or configured Claude endpoint.
  // This is sensitive server-side configuration: it may contain URL auth or a
  // signed query and is never serialized onto the browser wire. Persisting it
  // in the owner-only checkpoint prevents recovery from silently drifting.
  endpoint?: string;
  // UX.8: why an endpoint is here. A discovered endpoint is always driven
  // with both real Anthropic credentials withheld. A configured endpoint may
  // use only the credential MODE explicitly bound to it at selection time.
  endpointSource?: "configured" | "discovered";
  endpointAuth?: "api-key" | "auth-token" | "none";
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
export const PERMISSION_TIMEOUT_MS = envInt("PERMISSION_TIMEOUT_MS", 60_000);

// Cap a tool result before it hits the wire and the replay buffer. Byte-
// based (not char count) because the buffer's memory cost is bytes, and
// honest: the elided amount is reported so the client marks it, never a
// silent cut. Env-overridable (tuning; also lets tests trip it on demand).
// Agent-neutral — any adapter's tool output flows through it.
const OUTPUT_CAP_BYTES = envInt("TOOL_OUTPUT_CAP_BYTES", 64_000);

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
