import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentName, ClientMsg, WireMsg } from "../protocol";
import type { SessionEntry, SessionRegistry } from "./registry";
import { runActionTool } from "./actions";
import { capBuffer, listTree, readWorkspaceFile, sniffBinary } from "./fs-explorer";
import { cleanRelPath, gitShowHead, gitTree } from "./git";
import { isSecretFile } from "../security/permissions";
import {
  ADAPTER_AGENTS,
  availableAgents,
  defaultAgent,
  errText,
  resolveChosenBackend,
  type Backend,
} from "../adapters";
import { allowedOverRelay } from "../provider-policy";
import { probeLocalServers } from "../local-models";
import { spawnBang } from "../pty/pty";
import { createLogger } from "../log";
import { VERSION } from "../version";

// How much of a `!` command's output rides into the agent's context with the
// next prompt (tail-kept — the end of a long output is usually the payload).
// The wire/replay stream is never capped by this; it only bounds the context
// injection so one verbose command can't eat the model's window.
const BANG_CONTEXT_CAP = Number(process.env.BANG_CONTEXT_CAP ?? 16_000);

// How much of a `!` command's output reaches the wire — and therefore
// the replay ring — per command (head-kept, honest marker; mirrors the
// TOOL_OUTPUT_CAP_BYTES pattern). Without it one runaway `!yes` floods every
// viewport, is replayed in full to each new tab, and its chunks evict the
// real transcript from the ring. The PTY keeps running past the cap and the
// agent-context tail above keeps accumulating — only the broadcast stops (R.4d).
const BANG_OUTPUT_CAP_BYTES = Number(process.env.BANG_OUTPUT_CAP_BYTES ?? 262_144);

// Minimum gap between `!` commands per session (2026-07-17 audit, finding 5):
// each bang now costs a model turn, so a hostile client bursting bangs is a
// token-burn vector, not just PTY churn. Humans never trip 400ms — the same
// threshold the action bridge uses.
const BANG_MIN_INTERVAL_MS = Number(process.env.BANG_MIN_INTERVAL_MS ?? 400);

// A handoff file bigger than the longest legal path was not written by the
// trap in pty.ts — refuse it (finding 3).
const CWD_HANDOFF_MAX_BYTES = 4096;

// Minimum gap between refresh_agents-triggered probe sweeps per connection
// (N.3). The picker polls every few seconds; anything faster serves the
// cached answer instead of re-probing localhost.
const REFRESH_MIN_INTERVAL_MS = Number(process.env.REFRESH_MIN_INTERVAL_MS ?? 1_000);

// Minimum gap between Explorer requests per connection AND per type (E.1) —
// fs_list walks the tree, so a hostile client must not turn it into a CPU
// grinder; the per-type split keeps a legitimate list-then-read pair from
// tripping it. Throttled requests still get a reply (an error), never
// silence — the client's request/reply correlation must always resolve.
const FS_MIN_INTERVAL_MS = Number(process.env.FS_MIN_INTERVAL_MS ?? 250);

// Same shape rule as bang ids: client-minted correlation ids are short and
// word-safe or the message is dropped whole.
const FS_ID_RE = /^[\w-]{1,64}$/;

/**
 * The transcript is fenced by <bash-input>/<bash-output>; output that itself
 * contains a closing fence could fake the block's end and smuggle what looks
 * like user text into the agent's turn (2026-07-17 audit, finding 4).
 * Neutralize exactly that sequence — everything else reaches the model
 * verbatim. Exported for the Tier-1 test.
 */
export const escapeTranscriptFence = (s: string) => s.replaceAll("</bash-", "<\\/bash-");

// Handoff files live in a daemon-owned 0700 directory (mkdtemp's mode), not
// bare shared /tmp — on a multi-user machine no other user can pre-place,
// replace, or read them (2026-07-17 audit, finding 1). Lazy so a daemon that
// never runs a bang never creates it; individual files are removed per
// command, the dir itself lives as long as the daemon.
let bangTmpDir: string | undefined;
const newCwdHandoffFile = () =>
  path.join(
    (bangTmpDir ??= mkdtempSync(path.join(os.tmpdir(), "mirafold-bang-"))),
    `cwd-${randomUUID().slice(0, 8)}`,
  );

/**
 * Read where the shell ended up (the EXIT-trap handoff in pty.ts) and apply
 * the terminal harness's rule: `cd` persists across `!` commands, but only
 * within the workspace and its children — an escape is undone and announced
 * with the same notice the terminal shows. A missing handoff file (exotic
 * shell, the command `exec`'d away, win32) means the cwd didn't move.
 */
const applyCwdHandoff = (
  registry: SessionRegistry,
  e: SessionEntry,
  runCwd: string,
  cwdFile: string,
) => {
  let landed: string | undefined;
  try {
    // Only a small regular file — the one thing the trap writes. A FIFO the
    // command swapped in would stall readFileSync (and with it the whole
    // daemon's event loop); a symlink could point the read elsewhere; an
    // oversized file was never a path (2026-07-17 audit, finding 3). lstat
    // never follows or blocks, so it's the safe gate.
    const st = lstatSync(cwdFile);
    if (st.isFile() && st.size <= CWD_HANDOFF_MAX_BYTES) {
      // realpath also drops a trailing newline's worth of ambiguity: the
      // captured path must exist NOW or it can't become the next spawn cwd.
      landed = realpathSync(readFileSync(cwdFile, "utf8").trim());
    }
  } catch {
    /* no capture for this shell/command */
  }
  try {
    rmSync(cwdFile, { force: true });
  } catch {
    /* never let tmpfile cleanup escape into the PTY exit path */
  }
  if (!landed || landed === runCwd) return;
  let root = e.cwd;
  try {
    root = realpathSync(e.cwd); // symlinked workspace: compare realpath to realpath
  } catch {
    /* keep the un-resolved root */
  }
  const rel = path.relative(root, landed);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    e.bangCwd = landed;
  } else {
    e.bangCwd = e.cwd;
    registry.broadcast(e, { type: "notice", text: `Shell cwd was reset to ${e.cwd}` });
  }
};

/**
 * Run one `!` command in the session's PTY and drive its whole
 * lifecycle — the bang_start/…/bang_end grammar, the head-kept wire budget
 * (what viewports and the replay ring see, R.4d), and the tail-kept context
 * accumulator that rides into the agent's next prompt (4.9).
 */
const startBang = (registry: SessionRegistry, e: SessionEntry, command: string, id: string) => {
  // Tail-kept accumulator, capped as data arrives — a long-running
  // command (`!yes`) must not grow server memory until exit.
  let output = "";
  let elided = 0;
  // Per-command wire budget (bytes broadcast / bytes withheld) (R.4d).
  let wireSent = 0;
  let wireElided = 0;
  // The bang cwd can vanish between commands (we cd'd somewhere the agent
  // then deleted) — fall back to the workspace root, not a failed spawn.
  if (!existsSync(e.bangCwd)) e.bangCwd = e.cwd;
  const runCwd = e.bangCwd;
  registry.broadcast(e, { type: "bang_start", command, id });
  try {
    // Out-of-band cwd handoff file (pty.ts) — never part of the PTY stream.
    // Inside the try: a failing mkdtemp must error the session, not the daemon.
    const cwdFile = newCwdHandoffFile();
    const proc = spawnBang(
      command,
      runCwd,
      (data) => {
        output += data;
        if (output.length > BANG_CONTEXT_CAP) {
          elided += output.length - BANG_CONTEXT_CAP;
          output = output.slice(-BANG_CONTEXT_CAP);
        }
        // Head-kept wire cap. Past it nothing is broadcast (so
        // nothing enters the ring); the marker announces the cut the
        // moment it happens, and the exit path reports the total (R.4d).
        const bytes = Buffer.byteLength(data, "utf8");
        const room = BANG_OUTPUT_CAP_BYTES - wireSent;
        if (room > 0) {
          const head =
            bytes <= room
              ? data
              : new TextDecoder().decode(Buffer.from(data, "utf8").subarray(0, room));
          wireSent += Math.min(bytes, room);
          wireElided += Math.max(0, bytes - room);
          registry.broadcast(e, { type: "bang_output", data: head, id });
          if (wireSent >= BANG_OUTPUT_CAP_BYTES) {
            registry.broadcast(e, {
              type: "bang_output",
              data: `\n(… output cap reached (${BANG_OUTPUT_CAP_BYTES} bytes) — further output elided …)\n`,
              id,
            });
          }
        } else {
          wireElided += bytes;
        }
      },
      (exitCode) => {
        e.bang = undefined;
        if (wireElided > 0) {
          registry.broadcast(e, {
            type: "bang_output",
            data: `(… ${wireElided} bytes elided …)\n`,
            id,
          });
        }
        registry.broadcast(e, { type: "bang_end", id, exitCode });
        applyCwdHandoff(registry, e, runCwd, cwdFile);
        // The transcript goes to the agent NOW, as its own turn — the
        // terminal answers a `!` immediately, not at the next typed prompt.
        // Agent-neutral (only the pushPrompt seam), and no user_prompt
        // broadcast: the bang strip itself is the visible trigger. The cwd
        // attributes keep the agent oriented — its own tools' shell is a
        // separate process and does NOT follow a bang `cd`. Tail-kept cap;
        // echo-off input (passwords) was never in the PTY output, so it
        // can't leak into context here either.
        const tail = elided > 0 ? `(… ${elided} chars elided …)\n` + output : output;
        const after = e.bangCwd !== runCwd ? ` cwd-after="${e.bangCwd}"` : "";
        e.session.pushPrompt(
          `<bash-input cwd="${runCwd}">${escapeTranscriptFence(command)}</bash-input>\n` +
            `<bash-output exit-code="${exitCode ?? "killed"}"${after}>\n${escapeTranscriptFence(tail)}</bash-output>`,
        );
      },
      cwdFile,
    );
    e.bang = { id, proc };
  } catch (err) {
    // A throwing spawn (missing shell — the win32 /bin/bash trap, R.4f)
    // is a session-level error, never a daemon death: this handler runs
    // inside the ws message path of a process with no uncaughtException
    // net, so an escaped throw here would take every session with it.
    registry.broadcast(e, {
      type: "error",
      message: `! failed to start: ${errText(err)}`,
    });
    registry.broadcast(e, { type: "bang_end", id, exitCode: null });
  }
};

// What a remote (relay) connection is told when a cockpit act would drive a
// subscription-backed session (M.2) — the same reasoning as the attach gate's
// refusal (R.4i), phrased for an action instead of an attach.
const RELAY_GATE_REFUSAL =
  "This session runs on a subscription login, which can't be driven over the relay. " +
  "Use an API key to drive an agent remotely.";

// Agents the browser is allowed to name at onboarding (P.4). A create message
// naming anything else falls back to the daemon default rather than erroring.
const OFFERABLE = new Set(ADAPTER_AGENTS);
const asAgent = (v: unknown): AgentName | undefined =>
  typeof v === "string" && OFFERABLE.has(v as AgentName) ? (v as AgentName) : undefined;

export type Connection = {
  /** Feed one raw client frame (JSON text) into this viewport. */
  handleMessage: (raw: string) => void;
  /** The transport is gone — detach from whatever this viewport watched. */
  close: () => void;
};

/**
 * One viewport's server side, transport-agnostic (Phase R.1). The local
 * WebSocket path and relay-multiplexed remote viewports share exactly this
 * logic, so to the registry a remote device is just another attached
 * viewport — same hello, same message grammar, same detach-on-close.
 */
export function openConnection(
  registry: SessionRegistry,
  viewport: (msg: WireMsg) => void,
  label = "ws",
  // Pairing info for the "connect a device" QR. The local WS path passes
  // it; the relay path never does — the code must not cross the relay (R.4).
  relay?: { url: string; code: string },
  // True for a viewport arriving over the paid relay (relay-client passes
  // it). The relay gate refuses to attach such a viewport to a subscription-
  // backed session; local viewports are never gated (R.4i).
  remote = false,
): Connection {
  const log = createLogger(label);
  // A connection is a viewport onto one registry session (Step 4.2) — or,
  // since 4.6, a fleet watcher observing the registry itself.
  let entry: SessionEntry | null = null;
  // Per-connection budget for forwarded client_error reports — the client
  // caps itself too, but a hostile client isn't bound by our bundle.
  let clientErrorReports = 0;
  let watching = false;
  let closed = false;
  // refresh_agents throttle (N.3): the picker polls on a slow interval, but a
  // hostile client could spam — bound the probe rate per connection. A
  // throttled refresh still answers, from the cache.
  let lastProbeAt = 0;
  // Explorer throttles (E.1), one clock per request type.
  let lastFsListAt = 0;
  let lastFsReadAt = 0;
  let lastFsDiffAt = 0;
  // At most one git child per connection (E.2) — like the bang
  // already-running refusal; a second request while busy errors, not queues.
  let gitInFlight = false;

  // Identity first, then the replayed history, then the live stream. 4.4:
  // a valid afterSeq turns the replay into a tail-only resume — the client
  // is told via `resumed` so it keeps its state instead of repainting.
  const attachTo = (e: SessionEntry, afterSeq?: number, fallback = false) => {
    // The relay gate. A remote viewport may not drive a subscription-
    // backed session — charging for remote access to it trips the closed-model
    // providers' reselling clauses (provider-policy.ts). Refuse WITHOUT
    // attaching, and leave `entry` as it was so the viewport keeps whatever it
    // legitimately watched. Local viewports are never gated. (A remote CREATE
    // that lands here leaves the just-created session unattached; it's idle-
    // reaped — the important case this closes is a phone attaching to a
    // subscription session a local tab started.) (R.4i)
    if (remote && !allowedOverRelay(e.kind)) {
      viewport({
        type: "refused",
        reason: "subscription-relay",
        message:
          "This session runs on a subscription login, which can't be used over the relay. Use an API key to drive an agent remotely.",
      });
      log.info(`refused remote viewport → session ${e.id} (${e.kind})`);
      return;
    }
    if (entry) registry.detach(entry, viewport);
    entry = e;
    const resumed = afterSeq !== undefined && registry.canResume(e, afterSeq);
    viewport({
      type: "session_created",
      sessionId: e.id,
      cwd: e.cwd,
      agent: e.agent,
      model: e.session.modelName,
      ...(resumed ? { resumed: true } : {}),
      ...(e.live ? {} : { demo: true }),
      // The caller asked for a session that no longer exists and got a
      // fresh one — the shell shows a notice instead of a silent swap (R.4c).
      ...(fallback ? { fallback: true } : {}),
    });
    registry.attach(e, viewport, resumed ? afterSeq : undefined);
    log.info(
      `viewport ${resumed ? `resumed @${afterSeq}` : "attached"} → session ${e.id} (${e.viewports.size} viewport(s))`,
    );
  };

  // Advertise which agents this daemon offers + which are live, so the
  // onboarding picker can render before any session exists. No agent assumed (P.4).
  // Also where the daemon was launched — the default cwd for new
  // sessions — plus home, so the client can show paths in ~-form (4.8).
  // Re-sent whole on refresh_agents (N.3) — availableAgents() reads the live
  // probe cache, so a re-send after a re-probe carries newly started servers.
  const sendAgents = () =>
    viewport({
      type: "agents",
      agents: availableAgents(),
      default: defaultAgent(),
      cwd: process.cwd(),
      home: os.homedir(),
      version: VERSION,
      ...(relay ? { relay } : {}),
    });
  sendAgents();

  // A viewport-scoped error reaches the terminal too — the browser may
  // be a stranger's; the terminal log is what lands in a bug report (R.4g).
  const sendError = (message: string) => {
    log.error(message);
    viewport({ type: "error", message });
  };

  // The client announces its build on attach/create; a skewed pair is
  // the first thing to know about a weird bug report, so log it here (R.4g).
  const noteClientVersion = (v: unknown) => {
    if (typeof v === "string" && v && v !== VERSION) {
      log.warn(`version skew: client v${v}, daemon v${VERSION}`);
    }
  };

  const handleMessage = (raw: string) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      sendError("malformed client message");
      return;
    }
    // A frame that parses to a non-object (`null`, a number, a bare string)
    // has no `.type` — and `null.type` THROWS, which on the local WS path
    // (index.ts has no try/catch around handleMessage) escapes to the
    // uncaughtException handler and exits the daemon. Reject it here, the same
    // shape as bad JSON. Unknown-but-object types still fall through the switch
    // untouched (the R.4h ignore-unknown contract).
    if (typeof msg !== "object" || msg === null) {
      sendError("malformed client message");
      return;
    }
    switch (msg.type) {
      case "create": {
        // A bad cwd (typo'd path) rejects the create rather than silently
        // working somewhere else — the viewport stays unattached and the
        // onboarding card shows the error (Step 4.8).
        noteClientVersion(msg.clientVersion);
        // N.5: the picker's backend choice is validated HERE, against current
        // detection + provider policy — never trusted. A refused choice is a
        // create error (the picker shows it); honoring it only with a valid
        // agent keeps a choice from riding an unknown-agent fallback.
        const agent = asAgent(msg.agent);
        let backend: Backend | undefined;
        if (agent && msg.backend !== undefined) {
          const resolved = resolveChosenBackend(agent, msg.backend);
          if ("error" in resolved) {
            sendError(resolved.error);
            break;
          }
          backend = resolved;
          log.info(
            `create → ${agent} on chosen backend ${backend.kind}` +
              (backend.endpoint ? ` @ ${backend.endpoint}` : "") +
              (backend.model ? ` (${backend.model})` : ""),
          );
        }
        try {
          attachTo(
            registry.create({
              cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
              agent,
              backend,
            }),
          );
        } catch (err) {
          sendError(errText(err));
        }
        break;
      }
      case "attach": {
        // A stale/unknown id (old bookmark, server restart) gets a fresh
        // session rather than an error page — unless the session cap rejects
        // the fallback create, which surfaces as an error (not a crash).
        noteClientVersion(msg.clientVersion);
        const existing =
          typeof msg.sessionId === "string" ? registry.get(msg.sessionId) : undefined;
        const afterSeq =
          existing && typeof msg.afterSeq === "number" ? msg.afterSeq : undefined;
        try {
          // fallback only when a session was actually ASKED for and is gone —
          // an id-less attach never had a transcript to lose.
          attachTo(
            existing ?? registry.create(),
            afterSeq,
            typeof msg.sessionId === "string" && !existing,
          );
        } catch (err) {
          sendError(errText(err));
        }
        break;
      }
      case "prompt":
        if (entry && typeof msg.text === "string" && msg.text.trim()) {
          // Echo the user turn through the session stream so every viewport
          // (and the replay buffer) renders the command strip.
          registry.broadcast(entry, { type: "user_prompt", text: msg.text });
          entry.session.pushPrompt(msg.text);
        }
        break;
      case "bang":
        // The `!` passthrough (4.9): run it in a PTY in the session's bang
        // cwd; the finished transcript reaches the agent as its own turn.
        if (!entry || typeof msg.command !== "string" || !msg.command.trim()) break;
        // `id` is a client-minted string (ClientMsg). Validate the RAW value —
        // String(msg.id) would coerce a missing/numeric id ("undefined", "123")
        // into something that passes the regex and launches a bang with a bad
        // correlation id.
        if (typeof msg.id !== "string" || !/^[\w-]{1,64}$/.test(msg.id)) break;
        if (entry.bang) {
          sendError("a ! command is already running (stop it first)");
          break;
        }
        // The burst throttle (finding 5) — checked only when nothing is
        // running, so the already-running refusal above keeps its message.
        // The paired bang_end keeps every viewport's grammar clean (the
        // issuer's bang bar clears, like the spawn-failure path).
        if (entry.lastBangAt !== undefined && Date.now() - entry.lastBangAt < BANG_MIN_INTERVAL_MS) {
          sendError("! commands are arriving too fast — wait a moment");
          registry.broadcast(entry, { type: "bang_end", id: msg.id, exitCode: null });
          break;
        }
        entry.lastBangAt = Date.now();
        startBang(registry, entry, msg.command, msg.id);
        break;
      case "bang_input":
        // EPHEMERAL SECRET PATH: straight to the PTY, nothing else — no
        // broadcast, no buffer, no log (a password may be in `data`).
        if (entry?.bang && entry.bang.id === msg.id && typeof msg.data === "string") {
          entry.bang.proc.write(msg.data);
        }
        break;
      case "bang_kill":
        if (entry?.bang && entry.bang.id === msg.id) entry.bang.proc.kill();
        break;
      case "ping":
        // Liveness only — answered on this connection, never buffered.
        viewport({ type: "pong" });
        break;
      case "watch_sessions":
        // This connection is the fleet page — snapshots, not a session (4.6).
        if (entry) {
          registry.detach(entry, viewport);
          entry = null;
        }
        watching = true;
        registry.watch(viewport);
        break;
      case "rename":
        if (typeof msg.sessionId === "string" && typeof msg.name === "string") {
          registry.rename(msg.sessionId, msg.name);
        }
        break;
      case "end_session":
        // Usable from a session viewport or a fleet watcher — the registry
        // tears the session down and signals any attached viewports (#11).
        if (typeof msg.sessionId === "string") {
          registry.end(msg.sessionId);
          log.info(`end_session → ${msg.sessionId}`);
        }
        break;
      // ---- Cockpit acts (M.2): sessionId-addressed like end_session, so a
      // fleet watcher acts without attaching. answer_permission and
      // prompt_session DRIVE the model, so a remote (relay) connection gets
      // the same R.4i gate attach applies; interrupt_session stays ungated
      // like end_session. Unknown ids error, never crash.
      case "answer_permission": {
        if (
          typeof msg.sessionId !== "string" ||
          typeof msg.id !== "string" ||
          typeof msg.allow !== "boolean"
        ) {
          break;
        }
        const target = registry.get(msg.sessionId);
        if (!target) {
          sendError(`no such session: ${msg.sessionId}`);
          break;
        }
        if (remote && !allowedOverRelay(target.kind)) {
          sendError(RELAY_GATE_REFUSAL);
          break;
        }
        registry.answerPermission(msg.sessionId, msg.id, msg.allow);
        log.info(`answer_permission → session ${msg.sessionId} (${msg.allow ? "allow" : "deny"})`);
        break;
      }
      case "interrupt_session":
        if (typeof msg.sessionId === "string") {
          if (registry.interruptSession(msg.sessionId)) {
            log.info(`interrupt_session → ${msg.sessionId}`);
          } else {
            sendError(`no such session: ${msg.sessionId}`);
          }
        }
        break;
      case "prompt_session": {
        if (typeof msg.sessionId !== "string" || typeof msg.text !== "string") break;
        const text = msg.text.trim();
        // The frame cap already bounds a message; this bounds what one grid
        // dispatch may push into a model turn.
        if (!text || text.length > 100_000) break;
        const target = registry.get(msg.sessionId);
        if (!target) {
          sendError(`no such session: ${msg.sessionId}`);
          break;
        }
        if (remote && !allowedOverRelay(target.kind)) {
          sendError(RELAY_GATE_REFUSAL);
          break;
        }
        registry.promptSession(msg.sessionId, text);
        log.info(`prompt_session → session ${msg.sessionId}`);
        break;
      }
      case "interrupt":
        entry?.session.interrupt();
        break;
      case "permission_response":
        if (typeof msg.id === "string" && typeof msg.allow === "boolean") {
          entry?.session.resolvePermission(msg.id, msg.allow);
        }
        break;
      case "action": {
        // Every component action is mediated here and logged (2.3).
        if (!entry || typeof msg.action !== "object" || msg.action === null) break;
        const src = typeof msg.sourceId === "string" ? msg.sourceId : "?";
        if (msg.action.kind === "prompt" && typeof msg.action.text === "string") {
          createLogger("action").info(`prompt from render ${src}`);
          registry.broadcast(entry, { type: "user_prompt", text: msg.action.text });
          entry.session.pushPrompt(msg.action.text);
        } else if (msg.action.kind === "tool" && typeof msg.action.name === "string") {
          const id = `action-${randomUUID().slice(0, 8)}`;
          registry.broadcast(entry, {
            type: "tool_use",
            name: msg.action.name,
            detail: `component action (${src})`,
            id,
          });
          const { output, isError } = runActionTool(
            msg.action.name,
            msg.action.args,
            entry.cwd,
          );
          registry.broadcast(entry, { type: "tool_result", output, isError, id });
        }
        // state actions never reach the server; anything else is ignored.
        break;
      }
      case "refresh_agents":
        // Re-probe local model servers, then re-send the hello — the picker's
        // "start it and it appears here" promise, live (N.3). Inside the
        // throttle window the cached answer goes back instead (still a reply:
        // the client's poll must never just vanish). The async resend checks
        // `closed` — the socket may be gone by the time the probe lands.
        if (Date.now() - lastProbeAt < REFRESH_MIN_INTERVAL_MS) {
          sendAgents();
          break;
        }
        lastProbeAt = Date.now();
        void probeLocalServers().then(() => {
          if (!closed) sendAgents();
        });
        break;
      case "fs_list": {
        // Explorer tree query (E.1) — answered on THIS connection only, like
        // pong/sessions: disk state is a query, not session history, so it
        // must never enter the broadcast stream or the replay ring. A bad id
        // drops the message whole (nothing to correlate a reply to); every
        // well-formed request gets exactly one reply.
        if (typeof msg.id !== "string" || !FS_ID_RE.test(msg.id)) break;
        const treeErr = (root: string, error: string) =>
          viewport({ type: "fs_tree", id: msg.id, root, entries: [], git: false, error });
        if (!entry) {
          treeErr("", "no session attached");
          break;
        }
        if (Date.now() - lastFsListAt < FS_MIN_INTERVAL_MS) {
          treeErr(entry.cwd, "requests are arriving too fast — retry shortly");
          break;
        }
        lastFsListAt = Date.now();
        if (gitInFlight) {
          treeErr(entry.cwd, "a git query is already running — retry shortly");
          break;
        }
        // Git's view first (E.2); not-a-repo / no-git degrades to the E.1
        // walk. Async now, so: root captured before the await (the viewport
        // may switch sessions under it), `closed` checked before replying,
        // and every path caught — an escaped throw exits the daemon.
        const root = entry.cwd;
        gitInFlight = true;
        void gitTree(root)
          .then((g) => {
            if (closed) return;
            if ("error" in g) {
              treeErr(root, g.error);
            } else if ("entries" in g) {
              viewport({
                type: "fs_tree",
                id: msg.id,
                root,
                entries: g.entries,
                git: true,
                ...(g.truncated ? { truncated: true } : {}),
              });
            } else {
              const r = listTree(root);
              if ("error" in r) {
                treeErr(root, r.error);
              } else {
                viewport({
                  type: "fs_tree",
                  id: msg.id,
                  root,
                  entries: r.entries,
                  git: false,
                  ...(r.truncated ? { truncated: true } : {}),
                });
              }
            }
          })
          .catch((err) => {
            if (!closed) treeErr(root, errText(err));
          })
          .finally(() => {
            gitInFlight = false;
          });
        break;
      }
      case "fs_read": {
        // Explorer file read (E.1) — same per-viewport reply rules as
        // fs_list; the path is validated raw here and jailed in the module.
        if (typeof msg.id !== "string" || !FS_ID_RE.test(msg.id)) break;
        const fileErr = (p: string, error: string) =>
          viewport({ type: "fs_file", id: msg.id, path: p, error });
        if (typeof msg.path !== "string" || msg.path.length === 0 || msg.path.length > 4_096) {
          fileErr("", "bad path");
          break;
        }
        if (!entry) {
          fileErr(msg.path, "no session attached");
          break;
        }
        if (Date.now() - lastFsReadAt < FS_MIN_INTERVAL_MS) {
          fileErr(msg.path, "requests are arriving too fast — retry shortly");
          break;
        }
        lastFsReadAt = Date.now();
        try {
          const r = readWorkspaceFile(entry.cwd, msg.path);
          if ("error" in r) {
            fileErr(msg.path, r.error);
          } else if ("binary" in r) {
            viewport({ type: "fs_file", id: msg.id, path: msg.path, binary: true, size: r.size });
          } else {
            viewport({
              type: "fs_file",
              id: msg.id,
              path: msg.path,
              content: r.content,
              size: r.size,
              ...(r.truncatedBytes ? { truncatedBytes: r.truncatedBytes } : {}),
            });
          }
        } catch (err) {
          fileErr(msg.path, errText(err));
        }
        break;
      }
      case "fs_diff": {
        // Explorer per-file diff (E.2): before = HEAD's version, after = the
        // working tree — the client diffs the pair; no hunk text on the wire.
        if (typeof msg.id !== "string" || !FS_ID_RE.test(msg.id)) break;
        const diffErr = (p: string, error: string) =>
          viewport({ type: "fs_file_diff", id: msg.id, path: p, error });
        if (typeof msg.path !== "string") {
          diffErr("", "bad path");
          break;
        }
        // Textual containment BEFORE git sees the path: `git show` resolves
        // against the repo, not the fs, so the realpath jail can't cover it —
        // a `../` here could read repo files above a subdirectory session.
        const rel = cleanRelPath(msg.path);
        if (!rel) {
          diffErr(msg.path.slice(0, 200), "bad path");
          break;
        }
        if (!entry) {
          diffErr(rel, "no session attached");
          break;
        }
        if (isSecretFile(rel)) {
          diffErr(rel, "environment files are never readable here");
          break;
        }
        if (Date.now() - lastFsDiffAt < FS_MIN_INTERVAL_MS) {
          diffErr(rel, "requests are arriving too fast — retry shortly");
          break;
        }
        lastFsDiffAt = Date.now();
        if (gitInFlight) {
          diffErr(rel, "a git query is already running — retry shortly");
          break;
        }
        const diffRoot = entry.cwd;
        gitInFlight = true;
        void gitShowHead(diffRoot, rel)
          .then((show) => {
            if (closed) return;
            if ("notGit" in show) {
              diffErr(rel, "not a git repository — no diff available");
              return;
            }
            if ("error" in show) {
              diffErr(rel, show.error);
              return;
            }
            const beforeBuf = "content" in show ? show.content : Buffer.alloc(0);
            if (sniffBinary(beforeBuf)) {
              viewport({ type: "fs_file_diff", id: msg.id, path: rel, binary: true });
              return;
            }
            // The after side. A missing working file is a REAL case (deleted
            // → after ""), not an error — but only plain absence; an
            // existing-but-unreadable path stays an error.
            let after = "";
            let afterTruncatedBytes: number | undefined;
            let exists = true;
            try {
              lstatSync(path.join(diffRoot, rel));
            } catch {
              exists = false;
            }
            if (exists) {
              const r = readWorkspaceFile(diffRoot, rel);
              if ("error" in r) {
                diffErr(rel, r.error);
                return;
              }
              if ("binary" in r) {
                viewport({ type: "fs_file_diff", id: msg.id, path: rel, binary: true });
                return;
              }
              after = r.content;
              afterTruncatedBytes = r.truncatedBytes;
            }
            const before = capBuffer(beforeBuf);
            viewport({
              type: "fs_file_diff",
              id: msg.id,
              path: rel,
              before: before.text,
              after,
              ...(before.truncatedBytes ? { beforeTruncatedBytes: before.truncatedBytes } : {}),
              ...(afterTruncatedBytes ? { afterTruncatedBytes } : {}),
            });
          })
          .catch((err) => {
            if (!closed) diffErr(rel, errText(err));
          })
          .finally(() => {
            gitInFlight = false;
          });
        break;
      }
      case "client_error":
        // The browser half's uncaught errors, landing in the flight-recorder
        // log so a front-end crash leaves a trace a bug report can attach.
        // Untrusted text: type-checked, clipped, counted — logged and nothing
        // else (never broadcast, never echoed into any surface).
        if (typeof msg.message === "string" && ++clientErrorReports <= 20) {
          const skew =
            typeof msg.clientVersion === "string" && msg.clientVersion !== VERSION
              ? ` (client v${msg.clientVersion})`
              : "";
          log.error(`client error${skew}: ${msg.message.slice(0, 2_000)}`);
        }
        break;
    }
  };

  const close = () => {
    closed = true;
    if (entry) {
      registry.detach(entry, viewport);
      log.info(`viewport detached ← session ${entry.id}`);
    }
    if (watching) registry.unwatch(viewport);
  };

  return { handleMessage, close };
}
