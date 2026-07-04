import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WireMsg } from "./protocol";
import { makeCanUseTool } from "./permissions";
import { makeRenderServer, RENDER_GUIDANCE } from "./render-tools";

/**
 * Common surface for the real agent session and the mock — the server
 * and everything downstream only ever talk to this interface.
 */
export interface AgentSession {
  pushPrompt(text: string): void;
  onMessage(cb: (msg: WireMsg) => void): void;
  close(): void;
}

/** Unbounded async queue used to feed the SDK's streaming-input generator. */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((value: T) => void)[] = [];

  push(item: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const CLOSE = Symbol("close");

/**
 * One persistent Agent SDK session. A single query() runs for the life of
 * the object; prompts are fed in through an async generator so the
 * conversation stays warm (and prompt-cached) across turns.
 */
export class Session implements AgentSession {
  private queue = new AsyncQueue<string | typeof CLOSE>();
  private listeners = new Set<(msg: WireMsg) => void>();
  private q: Query;
  private closed = false;

  constructor(opts?: { workspaceDir?: string; model?: string }) {
    const workspaceDir = path.resolve(opts?.workspaceDir ?? "workspace");
    mkdirSync(workspaceDir, { recursive: true }); // spawn fails on a missing cwd
    this.q = query({
      prompt: this.promptStream(),
      options: {
        model: opts?.model ?? process.env.DEFAULT_MODEL,
        cwd: workspaceDir,
        canUseTool: makeCanUseTool(workspaceDir),
        includePartialMessages: true, // gives us token-level text deltas
        mcpServers: { ui: makeRenderServer((msg) => this.emit(msg)) },
        systemPrompt: { type: "preset", preset: "claude_code", append: RENDER_GUIDANCE },
      },
    });
    void this.pump();
  }

  pushPrompt(text: string) {
    if (!this.closed) this.queue.push(text);
  }

  onMessage(cb: (msg: WireMsg) => void) {
    this.listeners.add(cb);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue.push(CLOSE);
    this.q.interrupt().catch(() => {});
  }

  private emit(msg: WireMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  private async *promptStream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const item = await this.queue.next();
      if (item === CLOSE) return;
      yield {
        type: "user",
        message: { role: "user", content: item },
        parent_tool_use_id: null,
      };
    }
  }

  /** Normalize the SDK's event stream into WireMsg. */
  private async pump() {
    try {
      for await (const msg of this.q) {
        switch (msg.type) {
          case "stream_event": {
            if (msg.parent_tool_use_id) break; // subagent traffic — not ours to render
            const ev = msg.event;
            if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
              this.emit({ type: "text_delta", text: ev.delta.text });
            } else if (ev.type === "content_block_start") {
              if (ev.content_block.type === "thinking") {
                this.emit({ type: "status", state: "thinking" });
              } else if (
                ev.content_block.type === "tool_use" ||
                ev.content_block.type === "server_tool_use"
              ) {
                this.emit({ type: "status", state: "tool", label: ev.content_block.name });
              }
            }
            break;
          }
          case "result": {
            if (msg.is_error) {
              const detail = "result" in msg ? msg.result : msg.subtype;
              this.emit({ type: "error", message: String(detail) });
            }
            this.emit({ type: "turn_end" });
            break;
          }
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
        this.emit({ type: "turn_end" });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mock content — five demo "personas", drawn from a shuffled deck with
// randomized details so an API-free demo feels varied.
// ---------------------------------------------------------------------------

const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const spark = (n = 14) =>
  Array.from({ length: n }, () => "▁▂▃▄▅▆▇█"[randInt(0, 7)]).join("");
const shuffled = <T,>(arr: readonly T[]): T[] =>
  [...arr].sort(() => Math.random() - 0.5);

const PROJECTS = ["aurora", "helios", "quasar", "meridian", "lattice", "voyager"] as const;
const SERVICES = ["api-gateway", "auth", "billing", "search", "ingest", "renderer", "scheduler"] as const;
const FILES = ["server/session.ts", "web/src/RenderZone.tsx", "lib/cache.ts", "worker/queue.ts"] as const;
const TOPICS = [
  "local-first sync engines",
  "WebGPU compute pipelines",
  "prompt-caching economics",
  "CRDT merge strategies",
] as const;
const TOOL_LABELS = ["Read", "Grep", "Bash", "Glob", "WebFetch"] as const;
const SENTENCES = [
  "The hot path allocates on every call, which dominates the flame graph.",
  "Cache locality, not algorithmic complexity, explains most of the variance.",
  "Retry storms amplify tail latency far more than raw throughput suggests.",
  "The write path fans out to three consumers, only one of which is critical.",
  "Batching at the boundary removes 80% of the round trips for free.",
  "Most of the cost is serialization, not the network itself.",
  "The failure mode is silent degradation rather than a clean crash.",
  "Backpressure is absorbed at the queue, so upstream never notices.",
] as const;
const sentence = () => pick(SENTENCES);

const welcomeTemplate = (prompt: string) => `## Mock session

You said: **${prompt}**

No \`ANTHROPIC_API_KEY\` is set, so this canned response exercises the
rendering pipeline instead of the real agent.

- Streaming text deltas ✓
- Markdown with [a safe link](https://example.com) ✓
- Fenced code:

\`\`\`ts
export type WireMsg = { type: "text_delta"; text: string };
\`\`\`

| feature | status |
| --- | --- |
| tables | render |
| links | open in new tab |

Set the API key in \`.env\` to talk to the live agent.`;

const analyticsTemplate = () => {
  const project = pick(PROJECTS);
  const rows = shuffled(SERVICES)
    .slice(0, randInt(4, 5))
    .map(
      (svc) =>
        `| \`${svc}\` | ${randInt(8, 40)}ms | ${randInt(60, 240)}ms | 0.0${randInt(1, 9)}% | ${pick(["▲", "▼"])} ${randInt(1, 12)}% |`,
    )
    .join("\n");
  return `## ⚡ Weekly performance — \`${project}\`

**Uptime:** 99.9${randInt(0, 9)}% · **Deploys:** ${randInt(3, 24)} · **MTTR:** ${randInt(4, 40)}m

| service | p50 | p99 | error rate | trend |
| --- | --- | --- | --- | --- |
${rows}

\`\`\`
requests  ${spark()}
errors    ${spark()}
latency   ${spark()}
\`\`\`

> 🔎 **Insight:** ${sentence()}

**Recommended next steps**

1. ${sentence()}
2. ${sentence()}
3. Re-run the load test and compare against [last week's baseline](https://example.com/baseline).`;
};

const codeReviewTemplate = () => {
  const file = pick(FILES);
  return `## Code review: \`${file}\`

Found **${randInt(2, 5)} issues** across ${randInt(1, 4)} files. ${sentence()}

### 🔴 Blocking — race in cache invalidation

\`\`\`diff
- const cached = this.cache.get(key);
- if (cached) return cached;
+ const cached = await this.cache.getOrLock(key);
+ if (cached !== undefined) return cached;
\`\`\`

### 🟡 Suggestion — hoist the invariant

\`\`\`ts
const root = path.resolve(workspaceDir); // compute once, not per call
export const isInside = (p: string) => p.startsWith(root + path.sep);
\`\`\`

> ${sentence()}

**Fix checklist**

- [x] Reproduce under load
- [ ] Patch the lock acquisition
- [ ] Add a regression test
- [ ] Backport to \`release/${randInt(1, 3)}.${randInt(0, 9)}\``;
};

const planTemplate = () => {
  const project = pick(PROJECTS);
  return `## Migration plan: \`${project}\` → workers

> **Goal:** ${sentence()}

### Phase 1 — extract the seam
- [x] Freeze the public interface
- [x] Add contract tests
- [ ] Route ${randInt(5, 25)}% of traffic through the shim

### Phase 2 — cut over
- [ ] Dual-write for ${randInt(2, 7)} days
- [ ] Compare checksums, then flip the read path

| risk | owner | mitigation |
| --- | --- | --- |
| replay divergence | @core | checksum audit job |
| queue backlog | @infra | autoscale at ${randInt(60, 85)}% |
| stale cache | @web | TTL drop to ${randInt(1, 10)}m |

**ETA:** ${randInt(2, 6)} weeks. ${sentence()}`;
};

const researchTemplate = () => {
  const topic = pick(TOPICS);
  return `## Research brief: ${topic}

**TL;DR:** ${sentence()}

### Findings

1. **Adoption is uneven.** ${sentence()}
2. **The bottleneck moved.** ${sentence()}
3. **Tooling is the moat.** ${sentence()}

> "${sentence()}" — [primary source](https://example.com/paper)

| source | type | relevance |
| --- | --- | --- |
| [Systems survey](https://example.com/survey) | paper | high |
| [Field notes](https://example.com/notes) | blog | medium |
| [Benchmark repo](https://example.com/bench) | code | high |

*Confidence: ${pick(["low", "medium", "high"])} — based on ${randInt(4, 12)} sources.*`;
};

const TEMPLATES: ((prompt: string) => string)[] = [
  welcomeTemplate,
  analyticsTemplate,
  codeReviewTemplate,
  planTemplate,
  researchTemplate,
];

// Sample `render` payloads (mock-first: the render flow works API-free).
// Props must satisfy the registry spec — validated by the 1.2 smoke test.
const MOCK_RENDERS: (() => { component: string; props: Record<string, unknown> })[] = [
  () => ({
    component: "card",
    props: {
      title: `Deploy verdict: ${pick(PROJECTS)}`,
      body: `**Ship it.** ${sentence()}`,
      footer: `mock render · ${new Date().toLocaleTimeString()}`,
    },
  }),
  () => ({
    component: "list",
    props: {
      title: "Follow-ups",
      ordered: true,
      items: [
        { text: sentence() },
        { text: sentence(), detail: `owner: @${pick(SERVICES)}` },
        { text: sentence() },
      ],
    },
  }),
  () => ({
    component: "table",
    props: {
      title: `Hot paths — \`${pick(PROJECTS)}\``,
      columns: ["service", "p99 (ms)", "calls/min"],
      rows: shuffled(SERVICES)
        .slice(0, 3)
        .map((svc) => [`\`${svc}\``, randInt(60, 240), randInt(200, 9000)]),
    },
  }),
  () => ({
    component: "chart",
    props: {
      title: `p99 latency — ${pick(PROJECTS)}`,
      kind: pick(["line", "bar"] as const),
      x: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      yLabel: "ms",
      series: shuffled(SERVICES)
        .slice(0, randInt(1, 3))
        .map((svc) => ({
          name: svc,
          values: Array.from({ length: 7 }, () => randInt(40, 240)),
        })),
    },
  }),
  () => ({
    component: "link-group",
    props: {
      title: "Sources",
      links: [
        { label: "Systems survey", href: "https://example.com/survey", description: "paper" },
        { label: "Benchmark repo", href: "https://example.com/bench" },
      ],
    },
  }),
];

/**
 * Stand-in session for API-free development: emits a scripted WireMsg
 * stream that covers every Phase 0 message type. Replies are drawn from
 * a shuffled deck of five templates so no template repeats until all
 * five have been seen.
 */
export class MockSession implements AgentSession {
  private listeners = new Set<(msg: WireMsg) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private deck: number[] = [];

  pushPrompt(text: string) {
    if (this.deck.length === 0) this.deck = shuffled(TEMPLATES.map((_, i) => i));
    const reply = TEMPLATES[this.deck.pop()!](text);

    let delay = 120;
    this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
    for (let i = randInt(1, 3); i > 0; i--) {
      delay += randInt(250, 550);
      const label = pick(TOOL_LABELS);
      this.schedule(() => this.emit({ type: "status", state: "tool", label }), delay);
    }
    delay += 250;
    for (const chunk of reply.match(/.{1,16}/gs) ?? []) {
      delay += 12;
      this.schedule(() => this.emit({ type: "text_delta", text: chunk }), delay);
    }
    // Every mock turn ends with a rendered component so the Phase 1 pipeline
    // is exercised without an API key.
    const { component, props } = pick(MOCK_RENDERS)();
    const label = `render_${component === "link-group" ? "links" : component}`;
    delay += 300;
    this.schedule(() => this.emit({ type: "status", state: "tool", label }), delay);
    delay += 400;
    this.schedule(
      () => this.emit({ type: "render", component, props, id: randomUUID() }),
      delay,
    );
    this.schedule(() => this.emit({ type: "turn_end" }), delay + 40);
  }

  onMessage(cb: (msg: WireMsg) => void) {
    this.listeners.add(cb);
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private emit(msg: WireMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  private schedule(fn: () => void, ms: number) {
    this.timers.push(setTimeout(fn, ms));
  }
}
