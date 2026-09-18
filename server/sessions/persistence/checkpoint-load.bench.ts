// Checkpoint load diagnostic (Phase CPERF). Not a test: no glob picks up
// `.bench.ts`, and it asserts nothing about timing. It drives the REAL
// registry and store with five mock sessions whose rings hold a fixed
// history, streams ordinary output at a fixed rate, and reports what the
// checkpoint path costs the event loop — so a before/after comparison is
// the same fixture on the same machine, not two anecdotes.
//
//   yarn -s node --import tsx server/sessions/persistence/checkpoint-load.bench.ts [--mb 5] [--seconds 6] [--json out.json]

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import type { Backend } from "../../adapters/types";
import type { SessionMsg } from "../../protocol";
import { SessionRegistry } from "../registry";
import { SessionCheckpointStore, type StoredSession } from "./session-store";

const MOCK_BACKEND: Backend = { agent: "codex", kind: "none", live: false };
const SESSIONS = 5;
const TICK_MS = 20;
const SEED_MESSAGE_BYTES = 8_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback;
}

const historyMb = Number(arg("mb", "5"));
const seconds = Number(arg("seconds", "6"));
const jsonOut = arg("json", "");

type Sample = { serializeMs: number; totalMs: number; bytes: number };

/** The production store with its two save paths timed from the outside. The
 *  synchronous path re-serializes once inside write(), so its "disk" figure
 *  is total minus one measured serialization. */
class TimedStore extends SessionCheckpointStore {
  sync: Sample[] = [];
  routineSamples: { syncMs: number; wallMs: number; outcome: string }[] = [];
  routineInFlight = 0;
  routineMaxInFlight = 0;

  override write(session: StoredSession) {
    const t0 = performance.now();
    const data = JSON.stringify(session);
    const t1 = performance.now();
    super.write(session);
    this.sync.push({ serializeMs: t1 - t0, totalMs: performance.now() - t0, bytes: Buffer.byteLength(data) });
  }
}

const routineProto = SessionCheckpointStore.prototype as unknown as {
  writeRoutine?: (session: StoredSession) => Promise<string>;
};
if (routineProto.writeRoutine) {
  const original = routineProto.writeRoutine;
  (TimedStore.prototype as unknown as { writeRoutine: typeof original }).writeRoutine = function (
    this: TimedStore,
    session: StoredSession,
  ) {
    const t0 = performance.now();
    this.routineInFlight++;
    this.routineMaxInFlight = Math.max(this.routineMaxInFlight, this.routineInFlight);
    const promise = original.call(this, session);
    const syncMs = performance.now() - t0; // the portion that occupied the loop
    return promise.then(
      (outcome) => {
        this.routineInFlight--;
        this.routineSamples.push({ syncMs, wallMs: performance.now() - t0, outcome });
        return outcome;
      },
      (err: unknown) => {
        this.routineInFlight--;
        this.routineSamples.push({ syncMs, wallMs: performance.now() - t0, outcome: "failed" });
        throw err;
      },
    );
  };
}

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const ms = (n: number) => `${n.toFixed(1)} ms`;

async function main() {
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-checkpoint-bench-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "mirafold-checkpoint-bench-cwd-"));
  const store = new TimedStore(storeDir);
  const registry = new SessionRegistry({ backend: MOCK_BACKEND, store, idleTimeoutMs: 600_000 });
  const entries = Array.from({ length: SESSIONS }, () => registry.create({ cwd }));
  const viewportMessages = entries.map(() => 0);
  entries.forEach((entry, i) => registry.attach(entry, () => void viewportMessages[i]++));

  // History: tool results are ordinary transcript frames that neither
  // coalesce nor force a boundary save, so the seed costs one timer.
  const seedCount = Math.ceil((historyMb * 1_000_000) / SEED_MESSAGE_BYTES);
  const seedText = "x".repeat(SEED_MESSAGE_BYTES);
  for (const entry of entries) {
    registry.broadcast(entry, { type: "user_prompt", text: "seed" });
    for (let i = 0; i < seedCount; i++) {
      registry.broadcast(entry, { type: "tool_result", output: seedText, id: `seed-${i}` });
    }
    registry.broadcast(entry, { type: "turn_end" });
  }
  const seeded = store.sync.length;
  const ringBytes = entries.map((entry) => entry.ring.bytes);
  store.sync = [];

  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const lateness: number[] = [];
  const ticks = Math.round((seconds * 1_000) / TICK_MS);
  const line = "streamed output line, ordinary prose the agent is typing right now.\n";
  const delta = (i: number): SessionMsg => ({ type: "text_delta", text: `${i} ${line}` });
  let last = performance.now();
  const started = last;
  await new Promise<void>((done) => {
    let n = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      lateness.push(now - last - TICK_MS);
      last = now;
      for (const entry of entries) registry.broadcast(entry, delta(n));
      if (++n >= ticks) {
        clearInterval(timer);
        done();
      }
    }, TICK_MS);
  });
  // Let the trailing debounce and any in-flight routine save land.
  await new Promise((r) => setTimeout(r, 600));
  const wall = performance.now() - started;
  loop.disable();

  const files = readdirSync(storeDir);
  const onDisk = files.filter((f) => f.endsWith(".json")).map((f) => statSync(path.join(storeDir, f)).size);
  const report = {
    fixture: { sessions: SESSIONS, historyMb, seedMessages: seedCount, tickMs: TICK_MS, ticks, wallMs: Math.round(wall) },
    ring: { bytes: ringBytes, seedSaves: seeded },
    eventLoop: {
      p50Ms: loop.percentile(50) / 1e6,
      p95Ms: loop.percentile(95) / 1e6,
      p99Ms: loop.percentile(99) / 1e6,
      maxMs: loop.max / 1e6,
      tickLateP95Ms: percentile(lateness, 95),
      tickLateMaxMs: Math.max(0, ...lateness),
      ticksLateOver50Ms: lateness.filter((l) => l > 50).length,
    },
    syncSaves: {
      count: store.sync.length,
      serializeMs: sum(store.sync.map((s) => s.serializeMs)),
      diskMs: sum(store.sync.map((s) => s.totalMs - s.serializeMs)),
      totalMs: sum(store.sync.map((s) => s.totalMs)),
      maxMs: Math.max(0, ...store.sync.map((s) => s.totalMs)),
    },
    routineSaves: {
      count: store.routineSamples.length,
      outcomes: store.routineSamples.reduce<Record<string, number>>((acc, r) => ((acc[r.outcome] = (acc[r.outcome] ?? 0) + 1), acc), {}),
      onLoopMs: sum(store.routineSamples.map((r) => r.syncMs)),
      offLoopWaitMs: sum(store.routineSamples.map((r) => r.wallMs - r.syncMs)),
      maxOnLoopMs: Math.max(0, ...store.routineSamples.map((r) => r.syncMs)),
      maxInFlight: store.routineMaxInFlight,
    },
    disk: { files: files.length, checkpointBytes: onDisk },
    delivered: viewportMessages,
  };

  console.log(`\ncheckpoint load — ${SESSIONS} sessions × ~${historyMb} MB history, ${ticks} ticks @ ${TICK_MS} ms (${(wall / 1000).toFixed(1)} s)`);
  console.log(`  ring bytes         ${ringBytes.map((b) => (b / 1e6).toFixed(1) + " MB").join(", ")}`);
  console.log(`  event loop delay   p50 ${ms(report.eventLoop.p50Ms)}  p95 ${ms(report.eventLoop.p95Ms)}  p99 ${ms(report.eventLoop.p99Ms)}  max ${ms(report.eventLoop.maxMs)}`);
  console.log(`  tick lateness      p95 ${ms(report.eventLoop.tickLateP95Ms)}  max ${ms(report.eventLoop.tickLateMaxMs)}  ticks >50 ms late: ${report.eventLoop.ticksLateOver50Ms}/${ticks}`);
  console.log(`  sync saves         ${report.syncSaves.count}  serialize ${ms(report.syncSaves.serializeMs)}  disk ${ms(report.syncSaves.diskMs)}  total ${ms(report.syncSaves.totalMs)}  max ${ms(report.syncSaves.maxMs)}`);
  console.log(`  routine saves      ${report.routineSaves.count} ${JSON.stringify(report.routineSaves.outcomes)}  on-loop ${ms(report.routineSaves.onLoopMs)} (max ${ms(report.routineSaves.maxOnLoopMs)})  off-loop wait ${ms(report.routineSaves.offLoopWaitMs)}  max in flight ${report.routineSaves.maxInFlight}`);
  console.log(`  on disk            ${files.length} files, ${onDisk.map((b) => (b / 1e6).toFixed(1) + " MB").join(", ")}`);

  if (jsonOut) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  }
  for (const entry of entries) registry.end(entry.id);
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
