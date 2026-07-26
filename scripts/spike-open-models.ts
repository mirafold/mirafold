// Consumer-app reliability spike (2026-07-24) — UNTRACKED scratch, not product code.
//
// Question under test: can open-weight models, driven through a plain
// OpenAI-compatible chat loop (no MCP, no agent engine), reliably call
// Mirafold's render tools with schema-valid props?
//
// Method: for each candidate model on OpenRouter, run a battery of
// consumer-shaped prompts with the REAL tool schemas (registry-spec zod
// shapes → JSON Schema) and the REAL model-facing guidance (RENDER_GUIDANCE),
// then strict-validate every emitted tool call with registrySchemas.
//
// Run from repo root:  npx tsx scripts/spike-open-models.ts [model-id ...]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { registryShapes, registrySchemas, type ComponentName } from "../server/registry-spec";
import { renderToolEntries, RENDER_TOOL_COMPONENT, type RenderToolName } from "../server/adapters/render-mcp-cmd";
import { RENDER_GUIDANCE } from "../server/render-tools";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- key: read from .env without exporting anywhere ------------------------
function apiKey(): string {
  const env = process.env.OPENROUTER_API_KEY;
  if (env) return env;
  const raw = readFileSync(join(ROOT, ".env"), "utf8");
  const m = raw.match(/^OPENROUTER_API_KEY\s*=\s*"?([^"\n]+)"?\s*$/m);
  if (!m) throw new Error("OPENROUTER_API_KEY not found in env or .env");
  return m[1].trim();
}
const KEY = apiKey();
const BASE = "https://openrouter.ai/api/v1";

// ---- tool definitions: the real schemas, OpenAI tool format ----------------
// Copied verbatim from server/render-tools.ts TOOL_DESCRIPTIONS (not exported
// there; spike-only duplicate, do not let drift into product code).
const TOOL_DESCRIPTIONS: Record<RenderToolName, string> = {
  render_card:
    "Show a card in the output zone: a single highlight, summary, or verdict set off from the prose.",
  render_list:
    "Show a list component in the output zone. Use instead of a markdown bullet/numbered list.",
  render_table: "Show a table component in the output zone. Use instead of a markdown table.",
  render_chart:
    "Show a chart in the output zone: line for trends over an ordered axis, bar for category comparisons. Use for ANY plot/graph — never hand-write SVG or ASCII charts.",
  render_links:
    "Show a group of links in the output zone. Use for any collection of URLs worth clicking.",
  render_keyvalue:
    "Show a two-column key/value fact sheet in the output zone. Use for config dumps, environment summaries, or any set of name→value facts.",
  render_progress:
    "Show a progress bar for long-running work. Re-call with the returned id to advance the bar in place instead of stacking bars.",
  render_timeline:
    "Show an ordered timeline in the output zone. Use when the sequence of events or stages is itself the point (chronology, plan, release history).",
  render_filetree:
    "Show a file/directory tree in the output zone. Use for ANY file-structure picture — never hand-draw ASCII trees.",
  render_question:
    "Ask the user a structured question with 2–6 clickable options. Clicking one sends its text as the user's next turn. Use when the next step is the user's call between concrete alternatives; never for open-ended questions.",
  render_diff:
    "Show a red/green line diff of a code change, made or proposed. Per file, pass the relevant lines as they were (before) and as they are/would be (after) — verbatim code, no +/- prefixes; the client computes the diff. Use instead of hand-written diff code fences.",
};

const idParam = {
  id: z
    .string()
    .optional()
    .describe(
      "Omit to render a new component. Pass an id returned by a previous " +
        "render_* call to update that component in place instead.",
    ),
};

type ToolDef = { type: "function"; function: { name: string; description: string; parameters: unknown } };

const toolDefs: ToolDef[] = renderToolEntries.map(([name, component]) => ({
  type: "function",
  function: {
    name,
    description: TOOL_DESCRIPTIONS[name],
    parameters: z.toJSONSchema(z.object({ ...registryShapes[component], ...idParam }), {
      unrepresentable: "any",
    }),
  },
}));
toolDefs.push({
  type: "function",
  function: {
    name: "emit_artifact",
    description:
      "Render self-contained HTML/CSS/JS in a sandboxed iframe. LAST RESORT: use only when no " +
      "render_* component can express what's needed (custom visuals, simulations, bespoke " +
      "interactivity). Must be fully self-contained; no network access.",
    parameters: z.toJSONSchema(
      z.object({
        html: z.string().describe("Body markup only; inline <style>/<script> fine; self-contained."),
        title: z.string().optional(),
        ...idParam,
      }),
      { unrepresentable: "any" },
    ),
  },
});

const SYSTEM_PROMPT =
  "You are Mirafold, a friendly assistant in a beautiful mobile chat app for everyday " +
  "(non-technical) people. Answer helpfully and concisely.\n" +
  RENDER_GUIDANCE;

// ---- the battery: consumer-shaped prompts, visual-leaning ------------------
type Case = { name: string; prompt: string; followUp?: string; expect: ComponentName[] };
const BATTERY: Case[] = [
  { name: "phone-compare", prompt: "Compare the iPhone 16 and Pixel 9 for someone who mostly cares about the camera.", expect: ["table"] },
  { name: "workout-plan", prompt: "Make me a simple weekly workout plan, 4 days, no equipment.", expect: ["list", "table", "timeline"] },
  {
    name: "budget-chart",
    prompt:
      "My monthly spending: rent 1800, groceries 520, eating out 340, car 410, subscriptions 85, misc 240. Show me where my money goes.",
    followUp: "Nice — now sort it biggest to smallest and update the chart.",
    expect: ["chart"],
  },
  { name: "tokyo-trip", prompt: "I'm planning a 5-day trip to Tokyo in November — build me an itinerary.", expect: ["timeline", "list"] },
  { name: "camping-list", prompt: "Packing checklist for a weekend camping trip with two little kids.", expect: ["list"] },
  {
    name: "sleep-data",
    prompt: "Here are my last 7 nights of sleep in hours: 6.2, 7.1, 5.8, 8.0, 6.5, 7.4, 6.9. What do you see?",
    expect: ["chart"],
  },
  { name: "cat-or-dog", prompt: "Should I adopt a cat or a dog? Small apartment, I work from home.", expect: ["table", "card", "question"] },
  { name: "reading-goal", prompt: "I want to read 24 books this year and I've finished 9. How am I doing?", expect: ["progress", "card", "chart"] },
  { name: "dinner-recipe", prompt: "Give me an easy dinner recipe with chicken and rice.", expect: ["list", "keyvalue"] },
  { name: "apollo", prompt: "What were the key events of the Apollo program?", expect: ["timeline"] },
];

// ---- candidate models (overridable via argv) -------------------------------
const DEFAULT_MODELS = [
  "moonshotai/kimi-k2",
  "deepseek/deepseek-chat-v3-0324",
  "qwen/qwen3-235b-a22b",
  "z-ai/glm-4.5",
  "meta-llama/llama-4-maverick",
  "mistralai/mistral-medium-3",
];

// ---- OpenRouter plumbing ---------------------------------------------------
type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: RawToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type RawToolCall = { id: string; type: string; function: { name: string; arguments: string } };

async function chat(model: string, messages: Msg[]): Promise<{
  message: { content: string | null; tool_calls?: RawToolCall[] };
  cost: number;
  tokens: { prompt: number; completion: number };
}> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools: toolDefs,
      tool_choice: "auto",
      max_tokens: 4000,
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as any;
  if (body.error) throw new Error(`${model}: ${JSON.stringify(body.error).slice(0, 300)}`);
  const choice = body.choices?.[0];
  if (!choice?.message) throw new Error(`${model}: no message in response`);
  return {
    message: choice.message,
    cost: body.usage?.cost ?? 0,
    tokens: { prompt: body.usage?.prompt_tokens ?? 0, completion: body.usage?.completion_tokens ?? 0 },
  };
}

// ---- per-case run: the mini chat loop --------------------------------------
type CallRecord = {
  tool: string;
  component: ComponentName | null;
  argsParsed: boolean;
  valid: boolean;
  error?: string;
  reusedId?: boolean;
};
type CaseResult = {
  case: string;
  turns: number;
  calls: CallRecord[];
  usedExpected: boolean;
  finalTextChars: number;
  latencyMs: number;
  cost: number;
  failed?: string;
};

async function runCase(model: string, c: Case): Promise<CaseResult> {
  const messages: Msg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: c.prompt },
  ];
  const calls: CallRecord[] = [];
  const issuedIds = new Set<string>();
  let cost = 0;
  let finalText = "";
  let turns = 0;
  const start = Date.now();

  const drive = async () => {
    for (let round = 0; round < 6; round++) {
      const r = await chat(model, messages);
      cost += r.cost;
      const tcs = r.message.tool_calls ?? [];
      if (r.message.content) finalText = r.message.content;
      if (tcs.length === 0) return;
      messages.push({ role: "assistant", content: r.message.content ?? null, tool_calls: tcs });
      for (const tc of tcs) {
        const name = tc.function.name;
        const component = (RENDER_TOOL_COMPONENT as Record<string, ComponentName | undefined>)[name] ?? null;
        const rec: CallRecord = { tool: name, component, argsParsed: false, valid: false };
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
          rec.argsParsed = true;
        } catch (e) {
          rec.error = `bad JSON args: ${String(e).slice(0, 120)}`;
        }
        const { id: passedId, ...props } = args;
        if (typeof passedId === "string" && issuedIds.has(passedId)) rec.reusedId = true;
        if (rec.argsParsed && component) {
          const parsed = registrySchemas[component].safeParse(props);
          rec.valid = parsed.success;
          if (!parsed.success) rec.error = parsed.error.issues[0]
            ? `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}`
            : "invalid";
        } else if (rec.argsParsed && name === "emit_artifact") {
          rec.valid = typeof props.html === "string";
        } else if (rec.argsParsed) {
          rec.error = "unknown tool";
        }
        calls.push(rec);
        const newId = typeof passedId === "string" ? passedId : randomUUID();
        issuedIds.add(newId);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Rendered ${component ?? name} (id: ${newId})`,
        });
      }
    }
  };

  try {
    turns = 1;
    await drive();
    if (c.followUp) {
      turns = 2;
      messages.push({ role: "user", content: c.followUp });
      await drive();
    }
  } catch (e) {
    return {
      case: c.name, turns, calls, usedExpected: false,
      finalTextChars: finalText.length, latencyMs: Date.now() - start, cost,
      failed: String(e).slice(0, 300),
    };
  }

  return {
    case: c.name,
    turns,
    calls,
    usedExpected: calls.some((x) => x.component !== null && c.expect.includes(x.component)),
    finalTextChars: finalText.length,
    latencyMs: Date.now() - start,
    cost,
  };
}

// ---- model verification & main ---------------------------------------------
async function availableModelIds(): Promise<Set<string>> {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const body = (await res.json()) as any;
  return new Set((body.data ?? []).map((m: any) => m.id as string));
}

async function main() {
  const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS;
  const known = await availableModelIds();
  const run: string[] = [];
  for (const m of models) {
    if (known.has(m)) run.push(m);
    else {
      const stem = m.split("/")[1]?.split("-").slice(0, 2).join("-") ?? m;
      const close = [...known].filter((k) => k.includes(stem)).slice(0, 5);
      console.log(`SKIP ${m} — not on OpenRouter. Close matches: ${close.join(", ") || "none"}`);
    }
  }

  const all: Record<string, CaseResult[]> = {};
  await Promise.all(
    run.map(async (model) => {
      const results: CaseResult[] = [];
      for (const c of BATTERY) {
        const r = await runCase(model, c);
        results.push(r);
        const validCalls = r.calls.filter((x) => x.valid).length;
        console.log(
          `${model}  ${c.name.padEnd(14)} calls=${r.calls.length} valid=${validCalls} ` +
            `expected=${r.usedExpected ? "y" : "N"} ${r.failed ? "FAILED: " + r.failed : ""}`,
        );
      }
      all[model] = results;
    }),
  );

  console.log("\n===== SUMMARY =====");
  console.log(
    "model".padEnd(38) + "used-tool  valid-props  hit-expected  id-reuse  errors  cost",
  );
  for (const [model, results] of Object.entries(all)) {
    const cases = results.length;
    const usedTool = results.filter((r) => r.calls.some((x) => x.component !== null)).length;
    const totalCalls = results.reduce((n, r) => n + r.calls.length, 0);
    const validCalls = results.reduce((n, r) => n + r.calls.filter((x) => x.valid).length, 0);
    const hitExpected = results.filter((r) => r.usedExpected).length;
    const reuse = results.some((r) => r.calls.some((x) => x.reusedId));
    const failures = results.filter((r) => r.failed).length;
    const cost = results.reduce((n, r) => n + r.cost, 0);
    console.log(
      model.padEnd(38) +
        `${usedTool}/${cases}`.padEnd(11) +
        `${validCalls}/${totalCalls}`.padEnd(13) +
        `${hitExpected}/${cases}`.padEnd(14) +
        (reuse ? "yes" : "no").padEnd(10) +
        `${failures}`.padEnd(8) +
        `$${cost.toFixed(3)}`,
    );
  }

  const outDir = process.env.SPIKE_OUT_DIR ?? join(ROOT, "scripts");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `spike-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify(all, null, 2));
  console.log(`\nFull results: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
