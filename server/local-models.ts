// Local model server discovery (Phase N.2). HTTP probing ONLY — never
// filesystem scanning: per-tool model storage layouts are unstable, and an
// unserved model is unusable anyway (the Phase N charter decision). Probes go
// to localhost's well-known runtime ports plus MIRAFOLD_LOCAL_ENDPOINTS —
// nothing else is ever probed.
//
// Dialect is the compatibility key (not the model): Ollama answers its native
// /api/tags and speaks BOTH the Anthropic-shaped and OpenAI-shaped APIs, so
// its models can back Claude Code and Codex; everything else that answers
// GET /v1/models (the de facto standard catalog endpoint) is OpenAI-shaped
// only. Listing needs no model loaded in memory — the catalog is bookkeeping.

export type LocalDialect = "anthropic" | "openai";

export type LocalServer = {
  /** Origin the agent would be pointed at, e.g. "http://127.0.0.1:11434". */
  endpoint: string;
  /** Best-effort runtime name — from /api/tags (ollama) or the port's default. */
  runtime: string;
  dialects: LocalDialect[];
  models: string[];
};

// Per-probe budget. Localhost answers in single-digit ms when a server is up;
// the budget exists so a hung socket can never stall the caller — probes are
// parallel, so this also bounds the whole sweep.
const PROBE_TIMEOUT_MS = 500;

// Bloat insurance where engine-external data first enters our process (the
// R.6 model-label-cap philosophy): a corrupt catalog must not balloon the
// hello frame N.3 puts it on.
const MAX_MODELS = 128;
const MAX_NAME_LENGTH = 120;

// The probe budget bounds TIME; this bounds SIZE (2026-07-17 audit). Over
// loopback a hostile local listener can push hundreds of MB inside 500ms,
// and parsing that would spike the daemon's memory — a real catalog is a few
// KB, so anything past this is refused, not read.
const MAX_PROBE_BODY_BYTES = 1_000_000;

const WELL_KNOWN: { origin: string; runtime: string }[] = [
  { origin: "http://127.0.0.1:11434", runtime: "ollama" },
  { origin: "http://127.0.0.1:1234", runtime: "lm-studio" },
  { origin: "http://127.0.0.1:8000", runtime: "vllm" },
  { origin: "http://127.0.0.1:8080", runtime: "llama.cpp" },
];

/** The probe list: the well-known localhost ports + env-listed extras (the
 *  nonstandard-port escape hatch). Exported pure so tests can pin the env
 *  parsing without touching real ports. Invalid URLs are dropped silently —
 *  never echoed into an error a viewer could see raw env input in.
 *  `MIRAFOLD_LOCAL_DISCOVERY=off` skips the well-known ports (a no-probing
 *  opt-out; env-listed extras are still honored — the user asked for those).
 *  The itest harness forces it off so a dev machine's real Ollama can never
 *  leak into a Tier-2 assertion. */
export function probeTargets(): { origin: string; runtime: string }[] {
  const wellKnown = process.env.MIRAFOLD_LOCAL_DISCOVERY === "off" ? [] : WELL_KNOWN;
  const extras = (process.env.MIRAFOLD_LOCAL_ENDPOINTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((raw) => {
      try {
        return [{ origin: new URL(raw).origin, runtime: "custom" }];
      } catch {
        return [];
      }
    });
  const seen = new Set<string>();
  return [...wellKnown, ...extras].filter(({ origin }) => {
    if (seen.has(origin)) return false;
    seen.add(origin);
    return true;
  });
}

/** "host:port" with localhost normalized to 127.0.0.1 — the key that says two
 *  URLs name the same local server (an env-configured ANTHROPIC_BASE_URL and
 *  a probe hit differ exactly this way). Undefined on a malformed URL. */
export function hostKey(url: string): string | undefined {
  try {
    const u = new URL(url);
    const host = u.hostname === "localhost" ? "127.0.0.1" : u.hostname;
    return `${host}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return undefined;
  }
}

/** GET a JSON body inside the probe budget and the size cap; undefined on ANY
 *  failure (refused, timeout, non-2xx, oversized, malformed) — discovery is
 *  failure-silent. Reads the body in chunks so an oversized response is
 *  abandoned at the cap, never buffered whole. */
async function fetchJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok || !res.body) return undefined;
    if (Number(res.headers.get("content-length")) > MAX_PROBE_BODY_BYTES) return undefined;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROBE_BODY_BYTES) {
        void reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function capNames(names: string[]): string[] {
  return names.slice(0, MAX_MODELS).map((n) => n.slice(0, MAX_NAME_LENGTH));
}

/** Pull a capped name list out of a catalog body of shape
 *  `{ [listKey]: [{ [nameKey]: string }] }`; undefined when it isn't one. */
function parseCatalog(body: unknown, listKey: string, nameKey: string): string[] | undefined {
  const list = (body as Record<string, unknown> | undefined)?.[listKey];
  if (!Array.isArray(list)) return undefined;
  const names = list
    .map((m) => (m as Record<string, unknown> | undefined)?.[nameKey])
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  return names.length ? capNames(names) : undefined;
}

/** Ollama's native catalog: `{ models: [{ name }] }`. */
function parseTags(body: unknown): string[] | undefined {
  return parseCatalog(body, "models", "name");
}

/** The OpenAI-shaped catalog: `{ data: [{ id }] }`. */
function parseV1Models(body: unknown): string[] | undefined {
  return parseCatalog(body, "data", "id");
}

async function probeOrigin(origin: string, runtimeGuess: string): Promise<LocalServer | undefined> {
  // Both endpoints in parallel inside one budget. /api/tags answering is the
  // Ollama fingerprint (and unlocks the anthropic dialect); otherwise a
  // /v1/models answer means an OpenAI-dialect server of whatever runtime.
  const [tags, v1] = await Promise.all([
    fetchJson(`${origin}/api/tags`),
    fetchJson(`${origin}/v1/models`),
  ]);
  const tagModels = parseTags(tags);
  if (tagModels)
    return { endpoint: origin, runtime: "ollama", dialects: ["anthropic", "openai"], models: tagModels };
  const v1Models = parseV1Models(v1);
  if (v1Models)
    return { endpoint: origin, runtime: runtimeGuess, dialects: ["openai"], models: v1Models };
  return undefined;
}

let cache: LocalServer[] = [];
let cacheAt = 0;
let inflight: Promise<LocalServer[]> | undefined;

// One sweep answers every caller inside this window: each open onboarding
// card polls refresh_agents on its own clock, and a sweep is a real HTTP
// probe per target. The TTL stays short enough that a freshly started
// server still appears within one poll or two — a longer window would turn
// the picker's "start it and it appears here" promise into a wait.
const PROBE_TTL_MS = Number(process.env.MIRAFOLD_LOCAL_PROBE_TTL_MS ?? 5_000);

/** The last probe's result, synchronously — what hello-building reads. Empty
 *  until the first probe lands; the daemon never waits on discovery. */
export function cachedLocalServers(): LocalServer[] {
  return cache;
}

async function refreshCache(targets: { origin: string; runtime: string }[]): Promise<LocalServer[]> {
  const results = await Promise.all(targets.map((t) => probeOrigin(t.origin, t.runtime)));
  cache = results.filter((r): r is LocalServer => r !== undefined);
  return cache;
}

/**
 * Sweep the targets (defaults to probeTargets()) in parallel and refresh the
 * cache. Bounded by PROBE_TIMEOUT_MS regardless of hung sockets; never
 * throws. Callers fire-and-forget at startup and re-run on N.3's
 * `refresh_agents` — a probe must never delay startup or error a session.
 * The default sweep is TTL-cached and coalesces concurrent callers onto one
 * in-flight sweep; explicit `targets` (tests) always probe.
 */
export async function probeLocalServers(
  targets?: { origin: string; runtime: string }[],
): Promise<LocalServer[]> {
  if (targets) return refreshCache(targets);
  if (Date.now() - cacheAt < PROBE_TTL_MS) return cache;
  inflight ??= refreshCache(probeTargets()).finally(() => {
    cacheAt = Date.now();
    inflight = undefined;
  });
  return inflight;
}
