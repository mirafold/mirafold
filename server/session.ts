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
  /** Halt the in-flight turn; the session stays warm for the next prompt. */
  interrupt(): void;
  /** The browser's answer to a permission_request (Phase T.3). */
  resolvePermission(id: string, allow: boolean): void;
  close(): void;
}

// How long a permission prompt waits for the browser before denying.
// Overridable for tests; deny-by-default is the security posture.
const PERMISSION_TIMEOUT_MS = Number(process.env.PERMISSION_TIMEOUT_MS ?? 60_000);

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

// The one human-salient argument of a tool call, for the transcript line.
// Ordered: the first key present wins (Bash → command, Read → file_path, …).
const DETAIL_KEYS = ["command", "file_path", "pattern", "url", "query", "description", "path"];

function toolDetail(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v) return v;
  }
  const json = JSON.stringify(rec);
  return json === "{}" ? undefined : json.slice(0, 160);
}

// Cap transcript output so a huge tool dump can't flood the wire; the full
// output still went to the model — this is only the human-facing record.
const OUTPUT_CAP = 8_000;

function resultText(content: unknown): string {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content
      .map((b) => (b?.type === "text" ? String(b.text) : `[${String(b?.type ?? "block")}]`))
      .join("\n");
  else text = content == null ? "" : JSON.stringify(content);
  return text.length > OUTPUT_CAP
    ? `${text.slice(0, OUTPUT_CAP)}\n… (+${text.length - OUTPUT_CAP} chars truncated)`
    : text;
}

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
  // tool_use ids we announced on the wire — results for anything else
  // (render tools, subagent internals) must not paint orphan records.
  private announcedTools = new Set<string>();
  // In-flight permission prompts, keyed by wire id → resolver.
  private pendingAsks = new Map<string, (allow: boolean) => void>();

  constructor(opts?: { workspaceDir?: string; model?: string }) {
    const workspaceDir = path.resolve(opts?.workspaceDir ?? "workspace");
    mkdirSync(workspaceDir, { recursive: true }); // spawn fails on a missing cwd
    this.q = query({
      prompt: this.promptStream(),
      options: {
        model: opts?.model ?? process.env.DEFAULT_MODEL,
        cwd: workspaceDir,
        canUseTool: makeCanUseTool(workspaceDir, this.ask),
        // ISOLATION: never inherit the host user's Claude Code config. The
        // default pulls in user/project/local settings — meaning the host's
        // permission allowlists (which can silently bypass canUseTool),
        // CLAUDE.md, and memory instructions. A daemon session found this
        // the hard way: "remember X" wrote into the host's real memory dir.
        settingSources: [],
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

  interrupt() {
    if (this.closed) return;
    // A pending permission prompt would keep the aborted turn hanging —
    // interrupt means the user walked away from it: deny.
    for (const finish of [...this.pendingAsks.values()]) finish(false);
    // The SDK also emits a result for the aborted turn; the extra turn_end
    // after the abort settles is a client-side no-op, kept as a guarantee.
    this.q
      .interrupt()
      .then(() => this.emit({ type: "turn_end" }))
      .catch(() => {}); // interrupting an idle session is not an error
  }

  resolvePermission(id: string, allow: boolean) {
    this.pendingAsks.get(id)?.(allow);
  }

  /** Pause the tool call on a browser prompt; deny on timeout or close. */
  private ask = (tool: string, detail: string): Promise<boolean> => {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = randomUUID();
      const finish = (allow: boolean) => {
        clearTimeout(timer);
        this.pendingAsks.delete(id);
        resolve(allow);
      };
      const timer = setTimeout(() => finish(false), PERMISSION_TIMEOUT_MS);
      this.pendingAsks.set(id, finish);
      this.emit({ type: "permission_request", tool, detail, id });
    });
  };

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const finish of [...this.pendingAsks.values()]) finish(false);
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
          case "assistant": {
            if (msg.parent_tool_use_id) break; // subagent traffic — not ours to render
            for (const block of msg.message.content) {
              if (block.type !== "tool_use") continue;
              // Render tools already paint their own component block.
              if (block.name.startsWith("mcp__ui__")) continue;
              this.announcedTools.add(block.id);
              this.emit({
                type: "tool_use",
                name: block.name,
                detail: toolDetail(block.input),
                id: block.id,
              });
            }
            break;
          }
          case "user": {
            if (msg.parent_tool_use_id) break;
            const content = msg.message.content;
            if (!Array.isArray(content)) break; // plain prompt echo, not tool results
            for (const block of content) {
              if (block.type !== "tool_result") continue;
              if (!this.announcedTools.delete(block.tool_use_id)) continue;
              this.emit({
                type: "tool_result",
                output: resultText(block.content),
                isError: block.is_error === true,
                id: block.tool_use_id,
              });
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
// Mock tool calls (Phase T.1): each yields a full use→result pair so the
// transcript's tool blocks are exercised API-free; the last one is an error.
const MOCK_TOOLS: (() => {
  name: string;
  detail: string;
  output: string;
  isError?: boolean;
})[] = [
  () => ({
    name: "Bash",
    detail: "ls -la src/",
    output: [
      `total ${randInt(24, 96)}`,
      ...shuffled(FILES)
        .slice(0, 3)
        .map(
          (f) =>
            `-rw-r--r--  1 dev dev  ${randInt(1, 9)}${randInt(100, 999)} Jul  4 1${randInt(0, 9)}:${randInt(10, 59)} ${f.split("/").pop()}`,
        ),
    ].join("\n"),
  }),
  () => ({
    name: "Grep",
    detail: `-rn "TODO" ${pick(FILES).split("/")[0]}/`,
    output: shuffled(FILES)
      .slice(0, 3)
      .map((f) => `${f}:${randInt(10, 240)}: // TODO: ${sentence().toLowerCase()}`)
      .join("\n"),
  }),
  () => ({
    name: "Read",
    detail: pick(FILES),
    output: Array.from({ length: 5 }, (_, i) => `${i + 1}→${pick(SENTENCES)}`).join("\n"),
  }),
  () => ({
    name: "Bash",
    detail: "yarn test --run",
    output: `$ vitest run
✗ ${pick(SERVICES)} › invalidates the cache on write
  AssertionError: expected 2 to be 1
    at ${pick(FILES)}:${randInt(20, 200)}:${randInt(2, 40)}
Tests: 1 failed, ${randInt(8, 30)} passed`,
    isError: true,
  }),
];
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
  private pendingAsks = new Map<string, (allow: boolean) => void>();

  pushPrompt(text: string) {
    // Deterministic 2.2 hook: an "interactive"-sounding prompt yields a card
    // with action buttons so the click→action→turn loop runs API-free.
    if (/interactive|button/i.test(text)) {
      this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
      let delay = 350;
      for (const chunk of "Here's the deploy control card — the buttons are live.".match(/.{1,16}/gs) ?? []) {
        delay += 14;
        this.schedule(() => this.emit({ type: "text_delta", text: chunk }), delay);
      }
      delay += 350;
      this.schedule(
        () =>
          this.emit({
            type: "render",
            component: "card",
            props: {
              title: `Deploy status — ${pick(PROJECTS)}`,
              body: `**Healthy.** ${sentence()}`,
              footer: "mock render · actions attached",
              actions: [
                {
                  label: "Explain more",
                  action: { kind: "prompt", text: "Explain the current deploy status in more detail." },
                },
                {
                  label: "List workspace",
                  action: { kind: "tool", name: "workspace_ls" },
                },
              ],
            },
            id: randomUUID(),
          }),
        delay,
      );
      this.schedule(() => this.emit({ type: "turn_end" }), delay + 40);
      return;
    }

    // Deterministic 3.2/3.3 hook: an "artifact"-sounding prompt emits a small
    // interactive artifact with bridge buttons (one allowlisted tool, one
    // off-allowlist, one prompt) so sandbox + bridge run API-free.
    if (/artifact/i.test(text)) {
      this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
      let delay = 350;
      for (const chunk of "No registry component fits this, so here's a sandboxed artifact — the buttons use the bridge.".match(/.{1,16}/gs) ?? []) {
        delay += 14;
        this.schedule(() => this.emit({ type: "text_delta", text: chunk }), delay);
      }
      delay += 300;
      this.schedule(() => this.emit({ type: "status", state: "tool", label: "emit_artifact" }), delay);
      delay += 400;
      this.schedule(
        () =>
          this.emit({
            type: "artifact",
            title: "bridge demo",
            html:
              '<div style="text-align:center;padding:24px">' +
              '<h2 style="margin:0 0 12px">Counter</h2>' +
              '<button id="b" style="font-size:20px;padding:8px 24px;cursor:pointer">clicks: <span id="n">0</span></button>' +
              '<div style="margin-top:16px;display:flex;gap:8px;justify-content:center">' +
              '<button id="ls">list workspace</button>' +
              '<button id="evil">off-allowlist</button>' +
              '<button id="ask">ask for details</button>' +
              "</div>" +
              "<script>" +
              "let n=0;document.getElementById('b').onclick=()=>{document.getElementById('n').textContent=++n};" +
              "document.getElementById('ls').onclick=()=>genui.tool('workspace_ls');" +
              // Raw postMessage on purpose: exercises the parent-side
              // validation path, not just the injected helper.
              "document.getElementById('evil').onclick=()=>parent.postMessage({genui:1,action:{kind:'tool',name:'secret_exfil'}},'*');" +
              "document.getElementById('ask').onclick=()=>genui.prompt('Tell me more about this workspace.');" +
              "</script>" +
              "</div>",
            id: randomUUID(),
          }),
        delay,
      );
      this.schedule(() => this.emit({ type: "turn_end" }), delay + 40);
      return;
    }

    // Deterministic T.3 hook: a "dangerous"-sounding prompt pauses on a
    // permission_request so the prompt bar is exercisable API-free.
    if (/dangerous|sudo|rm -rf/i.test(text)) {
      const id = randomUUID();
      this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
      this.schedule(() => {
        const timer = setTimeout(
          () => this.pendingAsks.get(id)?.(false),
          PERMISSION_TIMEOUT_MS,
        );
        this.timers.push(timer);
        this.pendingAsks.set(id, (allow) => {
          clearTimeout(timer);
          this.pendingAsks.delete(id);
          if (allow) this.playDangerousAllowed();
          else this.playDangerousDenied();
        });
        this.emit({
          type: "permission_request",
          tool: "Bash",
          detail: "rm -rf /var/cache/app && systemctl restart app",
          id,
        });
      }, 450);
      return;
    }

    if (this.deck.length === 0) this.deck = shuffled(TEMPLATES.map((_, i) => i));
    const reply = TEMPLATES[this.deck.pop()!](text);

    let delay = 120;
    this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
    for (let i = randInt(1, 2); i > 0; i--) {
      const t = pick(MOCK_TOOLS)();
      const id = randomUUID();
      delay += randInt(250, 550);
      this.schedule(() => {
        this.emit({ type: "status", state: "tool", label: t.name });
        this.emit({ type: "tool_use", name: t.name, detail: t.detail, id });
      }, delay);
      delay += randInt(300, 700);
      this.schedule(
        () => this.emit({ type: "tool_result", output: t.output, isError: t.isError, id }),
        delay,
      );
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

  interrupt() {
    // Everything still scheduled belongs to the in-flight turn; abandoned
    // permission prompts die with it (deny by default).
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.pendingAsks.clear();
    this.emit({ type: "turn_end" });
  }

  resolvePermission(id: string, allow: boolean) {
    this.pendingAsks.get(id)?.(allow);
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.pendingAsks.clear();
  }

  /** Continuation after the permission prompt was allowed: run the "command". */
  private playDangerousAllowed() {
    const id = randomUUID();
    this.schedule(() => {
      this.emit({ type: "status", state: "tool", label: "Bash" });
      this.emit({
        type: "tool_use",
        name: "Bash",
        detail: "rm -rf /var/cache/app && systemctl restart app",
        id,
      });
    }, 150);
    this.schedule(
      () =>
        this.emit({
          type: "tool_result",
          output: `removed ${randInt(80, 400)} files (${randInt(40, 900)} MB)\napp.service restarted — active (running)`,
          id,
        }),
      900,
    );
    let delay = 1100;
    for (const chunk of "Cache cleared and the service restarted cleanly. ✅".match(/.{1,16}/gs) ?? []) {
      delay += 14;
      this.schedule(() => this.emit({ type: "text_delta", text: chunk }), delay);
    }
    this.schedule(() => this.emit({ type: "turn_end" }), delay + 60);
  }

  /** Continuation after the permission prompt was denied (or timed out). */
  private playDangerousDenied() {
    let delay = 150;
    for (const chunk of "Understood — I won't run that command. Nothing was changed.".match(/.{1,16}/gs) ?? []) {
      delay += 14;
      this.schedule(() => this.emit({ type: "text_delta", text: chunk }), delay);
    }
    this.schedule(() => this.emit({ type: "turn_end" }), delay + 60);
  }

  private emit(msg: WireMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  private schedule(fn: () => void, ms: number) {
    this.timers.push(setTimeout(fn, ms));
  }
}
