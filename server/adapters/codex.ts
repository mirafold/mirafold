import path from "node:path";
import { mkdirSync } from "node:fs";
import type { SessionMsg } from "../protocol";
import { RENDER_GUIDANCE } from "../render-tools";
import type { AgentSession } from "./types";
import type { CodexModel } from "./codex-model-list";
import { AsyncQueue, CLOSE } from "./async-queue";
import { listCodexSkills, type CodexSkill } from "./codex-skills-list";
import { ResumeIdState } from "./resume-id";
import { PermissionLedger } from "./wire-helpers";
import { isWorkspaceTrusted, trustWorkspace } from "../sessions/workspace-trust";
import { PERMISSION_TIMEOUT_MS } from "./types";
import { envInt } from "../env";
import {
  codexEngineDefaultModel,
  createCodexRuntimeBinding,
  type CodexBackendKind,
} from "./codex-binding";
import { CODEX_DEFERRED_TOOLS_ADDENDUM } from "./codex-prompt";
import {
  CODEX_EFFORT_STAND_IN,
  refreshCodexPromptOptions,
  runCodexEffortCommand,
  runCodexModelCommand,
  type CodexReasoningEffort,
} from "./codex-commands";
import { CodexEventMapper, turnErrorMessage } from "./codex-events";
import {
  codexLocalTurnTimeoutDiagnostic,
  codexProviderDiagnostic,
  codexTurnDiagnostic,
} from "./codex-diagnostics";
import {
  spawnAppServer,
  type AppServerClient,
  type AppServerSpawn,
  type JsonRpcId,
} from "./codex-app-server";

export { CODEX_DEFERRED_TOOLS_ADDENDUM } from "./codex-prompt";
export { extractRenderId, mcpText, type CodexMcpToolCall } from "./codex-events";

// Internal-only sentinel until the engine reports the model it resolved;
// `modelName` withholds it so the UI never presents a false model name.
const MODEL_STAND_IN = "codex";

// Discovered local endpoints need one outer turn bound because Codex's own
// retry policy can otherwise stay silent for minutes. Zero opts out.
const DEFAULT_LOCAL_TURN_TIMEOUT_MS = envInt(
  "MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS",
  8 * 60_000,
);
// A normal Stop ends when Codex reports turn/completed. If that notification
// never arrives, abandon the app-server after this bound so the serial prompt
// worker cannot stay wedged forever.
const DEFAULT_INTERRUPT_GRACE_MS = envInt("MIRAFOLD_CODEX_INTERRUPT_GRACE_MS", 5_000);

/** What Mirafold tells Codex at thread start — the where-are-the-tools note
 *  FIRST (codex-prompt.ts: Codex hides MCP tools behind tool_search or inside
 *  the exec runtime, and a model that has to hunt for a tool rarely does),
 *  then the render guidance — through app-server's `developerInstructions`,
 *  a real instructions hook (the exec path had none and rode the first turn). */
export const CODEX_DEVELOPER_INSTRUCTIONS = `${CODEX_DEFERRED_TOOLS_ADDENDUM}\n${RENDER_GUIDANCE}`;

// The folder-trust ask waits this long before denying — the same window
// Gemini's folder gate uses. A person reads the ask, not a machine.
const TRUST_PROMPT_TIMEOUT_MS = 5 * 60_000;
const STARTUP_INTERRUPTED = Symbol("startup-interrupted");

type ThreadInfo = { id: string; model?: string };

/** The `RequestPermissionProfile` of an `item/permissions/requestApproval`,
 *  in words a person can approve: `entries[]` (`access` + `path`), the
 *  legacy `read`/`write` path lists, and `network.enabled`. Shapes from the
 *  binary's own schema (`codex app-server generate-json-schema`). Read
 *  defensively — an engine profile is data, never trusted by shape. */
/** `FileSystemPath` (schema): a literal path, a glob, or one of the named
 *  special sets — the "root" one is the entire filesystem, and a person must
 *  read it as that, never as `{"kind":"root"}`. */
const SPECIAL_PATHS: Record<string, string> = {
  root: "the ENTIRE filesystem",
  minimal: "the minimal sandbox set",
  project_roots: "the project roots",
  tmpdir: "the temp directory",
  slash_tmp: "/tmp",
  unknown: "an unspecified location",
};
function describeFileSystemPath(p: unknown): string {
  if (typeof p === "string") return p;
  if (typeof p !== "object" || p === null) return "";
  const v = p as {
    type?: unknown;
    path?: unknown;
    pattern?: unknown;
    value?: { kind?: unknown; path?: unknown; subpath?: unknown } | null;
  };
  // Dispatch on the tag, as the engine does — never on which keys happen
  // to be present.
  if (v.type === "path" && typeof v.path === "string") return v.path;
  if (v.type === "glob_pattern" && typeof v.pattern === "string") return `${v.pattern} (glob)`;
  const kind = v.value?.kind;
  if (v.type === "special" && typeof kind === "string") {
    const sub = typeof v.value?.subpath === "string" && v.value.subpath ? v.value.subpath : "";
    // `unknown` carries the literal path the engine means (a subpath is
    // joined onto it); every other kind is a named set, and a subpath is a
    // directory INSIDE each of its members.
    if (typeof v.value?.path === "string") return sub ? `${v.value.path.replace(/\/+$/, "")}/${sub}` : v.value.path;
    const literal = SPECIAL_PATHS[kind] ?? `${kind} (special)`;
    return sub ? `${sub} inside ${kind === "project_roots" ? "each project root" : literal}` : literal;
  }
  return JSON.stringify(p);
}

export function describePermissionProfile(profile: Record<string, unknown>): string {
  const parts: string[] = [];
  const fs = profile["fileSystem"] as Record<string, unknown> | null | undefined;
  const asPaths = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  if (fs && typeof fs === "object") {
    for (const raw of Array.isArray(fs["entries"]) ? fs["entries"] : []) {
      const entry = raw as { access?: unknown; path?: unknown } | null;
      const pathText = describeFileSystemPath(entry?.path);
      if (pathText) parts.push(`${typeof entry?.access === "string" ? entry.access : "access"} ${pathText}`);
    }
    for (const p of asPaths(fs["read"])) parts.push(`read ${p}`);
    for (const p of asPaths(fs["write"])) parts.push(`write ${p}`);
  }
  const net = profile["network"] as { enabled?: unknown } | null | undefined;
  if (net && typeof net === "object" && net.enabled === true) parts.push("network access");
  return parts.length
    ? `grant for this turn: ${parts.join(", ")}`
    : "grant additional permissions for this turn (the engine named none)";
}
type TurnOutcome = { status: string; error?: unknown } | { exited: true };
type ActiveTurn = {
  id?: string;
  finish: (outcome: TurnOutcome) => void;
  interrupted: boolean;
  interruptSent: boolean;
  startupInterrupted: Promise<typeof STARTUP_INTERRUPTED>;
  interruptStartup: () => void;
  interruptTimer?: ReturnType<typeof setTimeout>;
};

/**
 * The Codex adapter: OpenAI's Codex, driven through its own `codex app-server`
 * protocol — the surface the Codex TUI and the VS Code extension use — over
 * one long-lived process per session. One thread carries the warm
 * conversation across turns; its notifications are normalized into the
 * shared `WireMsg` union (codex-events.ts), and the engine's approval
 * requests come back to it as answers.
 *
 * Faithful-skin posture (see the inherit-don't-invent principle): this adapter
 * passes ONLY Mirafold's genuine concerns — the session working directory
 * (session ≈ project), the model when configured, its render MCP server and
 * the provider the pick promised. It sets no sandbox/approval policy,
 * preserving the user's own Codex config; what the sandbox blocks, Codex asks
 * about, exactly as in the terminal (CA.1 spike, codex.spike.md).
 */
export class CodexSession implements AgentSession {
  private queue = new AsyncQueue<string | typeof CLOSE>();
  private listeners = new Set<(msg: SessionMsg) => void>();
  private workspaceDir: string;
  private readonly spawnSpec: AppServerSpawn;
  private readonly makeAppServer: (spec: AppServerSpawn) => AppServerClient;
  private client?: AppServerClient;
  private threadReady?: Promise<ThreadInfo>;
  private threadId?: string;
  private resumeIdState: ResumeIdState;
  private listModels: () => Promise<CodexModel[]>;
  private closed = false;
  private activeTurn?: ActiveTurn;
  private eventMapper: CodexEventMapper;
  // The engine's approval round-trips (command / patch / permission), and the
  // one folder-trust ask, both ride the shared permission ledger → the
  // browser's permission bar. Answers already sync across viewports.
  private permissions = new PermissionLedger((msg) => this.emit(msg));
  // Headless Codex was observed writing `[projects."<cwd>"] trust_level =
  // "trusted"` into the user's config.toml on the FIRST thread/start in a
  // folder, with no dialog (CA.1 spike, codex-cli 0.149.1; not reproduced
  // under a fresh CODEX_HOME on 2026-08-26, so it is state-dependent — the
  // ask says "may"). Either way the first turn in an untrusted folder asks
  // first, exactly as the terminal TUI does, and only calls thread/start on
  // a yes — any such write becomes consented, or never happens.
  private trusted = false;
  private modelLabel: string;
  // Per-turn options: a model/effort switch applies from the next turn on,
  // on the same warm thread (no restart, unlike the exec path).
  private model?: string;
  private effort?: CodexReasoningEffort;
  // The config/model default stays in force until `/effort` overrides it.
  private effortLabel: string = CODEX_EFFORT_STAND_IN;
  // A forced first-party provider must not inherit a custom provider's model.
  private needsEngineDefaultModel = false;
  // First-party catalogs must reject provider-qualified third-party model ids.
  private firstPartyOpenAI = false;
  private listEngineModels: () => Promise<CodexModel[]>;
  private listSkills: () => Promise<CodexSkill[]>;
  // Exact selected URL is retained only to redact it from diagnostics.
  private endpointForRedaction?: string;
  // Local-only effort/timeout behavior applies only to probe-discovered URLs.
  private discoveredLocalEndpoint = false;
  private localTurnTimeoutMs = 0;
  private permissionTimeoutMs = PERMISSION_TIMEOUT_MS;
  private interruptGraceMs = DEFAULT_INTERRUPT_GRACE_MS;

  get modelName(): string | undefined {
    return this.modelLabel === MODEL_STAND_IN ? undefined : this.modelLabel;
  }

  get resumeId(): string | undefined {
    return this.threadId;
  }

  onResumeId(cb: (id: string) => void) {
    this.resumeIdState.onChange(cb, this.threadId);
  }

  // `makeAppServer` and the catalog functions are constructor-level test seams.
  constructor(opts: {
    workspaceDir: string;
    model?: string;
    kind?: CodexBackendKind;
    endpoint?: string;
    provider?: string;
    resumeId?: string;
    makeAppServer?: (spec: AppServerSpawn) => AppServerClient;
    /** Unit-test seam; production uses PERMISSION_TIMEOUT_MS. */
    permissionTimeoutMs?: number;
    listModels?: () => Promise<CodexModel[]>;
    listEngineModels?: () => Promise<CodexModel[]>;
    listSkills?: () => Promise<CodexSkill[]>;
    /** Unit-test seam; production uses MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS. */
    localTurnTimeoutMs?: number;
    /** Unit-test seam; production uses MIRAFOLD_CODEX_INTERRUPT_GRACE_MS. */
    interruptGraceMs?: number;
  }) {
    const workspaceDir = path.resolve(opts.workspaceDir);
    mkdirSync(workspaceDir, { recursive: true });
    this.workspaceDir = workspaceDir;
    this.modelLabel = opts.model ?? MODEL_STAND_IN;
    this.model = opts.model;
    const kind = opts.kind ?? (process.env.OPENAI_API_KEY ? "api-key" : undefined);
    this.discoveredLocalEndpoint = kind === "local" && opts.endpoint !== undefined;
    if (this.discoveredLocalEndpoint) {
      const configuredTimeout = opts.localTurnTimeoutMs ?? DEFAULT_LOCAL_TURN_TIMEOUT_MS;
      this.localTurnTimeoutMs =
        Number.isFinite(configuredTimeout) && configuredTimeout >= 0
          ? configuredTimeout
          : DEFAULT_LOCAL_TURN_TIMEOUT_MS;
    }
    const runtime = createCodexRuntimeBinding({
      kind,
      endpoint: opts.endpoint,
      provider: opts.provider,
      model: opts.model,
      listModels: opts.listModels,
      listEngineModels: opts.listEngineModels,
    });
    this.spawnSpec = runtime.spawn;
    this.makeAppServer = opts.makeAppServer ?? spawnAppServer;
    this.firstPartyOpenAI = runtime.firstPartyOpenAI;
    this.endpointForRedaction = runtime.endpointForRedaction;
    this.threadId = opts.resumeId;
    this.resumeIdState = new ResumeIdState(opts.resumeId);
    this.eventMapper = new CodexEventMapper({
      emit: (message) => this.emit(message),
      workspaceDir,
      modelName: () => this.modelName,
      providerDiagnostic: (value) => codexProviderDiagnostic(value, this.endpointForRedaction),
    });
    this.listModels = runtime.listModels;
    this.listEngineModels = runtime.listEngineModels;
    this.listSkills =
      opts.listSkills ?? (() => listCodexSkills(workspaceDir, undefined, runtime.engineBin));
    this.needsEngineDefaultModel = runtime.needsEngineDefaultModel;
    if (opts.permissionTimeoutMs !== undefined) this.permissionTimeoutMs = opts.permissionTimeoutMs;
    if (opts.interruptGraceMs !== undefined) {
      this.interruptGraceMs = Math.max(0, opts.interruptGraceMs);
    }
    void this.worker();
  }

  refreshPromptOptions() {
    refreshCodexPromptOptions({
      emit: (message) => this.emit(message),
      listSkills: () => this.listSkills(),
      isClosed: () => this.closed,
    });
  }

  pushPrompt(text: string) {
    if (!this.closed) this.queue.push(text);
  }

  onMessage(cb: (msg: SessionMsg) => void) {
    this.listeners.add(cb);
  }

  interrupt() {
    // Halt the in-flight turn; the thread stays warm for the next prompt.
    const turn = this.activeTurn;
    if (!turn) return;
    turn.interrupted = true;
    turn.interruptStartup();
    // Stop owns every blocking ask too — folder trust before startup and
    // engine approvals after it. Leaving either unresolved pins the serial
    // worker until its long timeout and leaves a stale permission bar.
    this.permissions.denyAll();
    this.sendTurnInterrupt(turn);
  }

  /** Send at most one engine interrupt once both protocol ids exist, then
   * bound the wait for its terminal notification. Stop can arrive while
   * turn/start itself is awaiting its response; runTurn calls this again
   * after adopting the returned id. */
  private sendTurnInterrupt(turn: ActiveTurn) {
    if (!turn.id || !this.client || !this.threadId) return;
    const client = this.client;
    if (!turn.interruptSent) {
      turn.interruptSent = true;
      client
        .request("turn/interrupt", { threadId: this.threadId, turnId: turn.id })
        .catch(() => {
          /* the completion notification or grace fallback owns the end */
        });
    }
    if (turn.interruptTimer) return;
    turn.interruptTimer = setTimeout(() => {
      turn.interruptTimer = undefined;
      if (this.activeTurn !== turn) return;
      this.abandonAppServer(client);
      turn.finish({ exited: true });
    }, this.interruptGraceMs);
    turn.interruptTimer.unref?.();
  }

  /** A startup request has no turn id that Codex can interrupt. Detach and
   * kill that app-server so a missing or late response cannot pin the worker
   * or accept a ghost prompt. The known thread id, if any, is retained for a
   * fresh app-server to resume on the next turn. */
  private abandonAppServer(client: AppServerClient | undefined) {
    if (!client) return;
    if (this.client === client) {
      this.client = undefined;
      this.threadReady = undefined;
    }
    client.kill();
  }

  private awaitStartup<T>(turn: ActiveTurn, pending: Promise<T>) {
    return Promise.race<T | typeof STARTUP_INTERRUPTED>([pending, turn.startupInterrupted]);
  }

  // The browser's permission-bar answer for any ask this session raised —
  // an engine approval or the folder-trust question.
  resolvePermission(id: string, allow: boolean) {
    this.permissions.resolve(id, allow);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    this.permissions.denyAll(); // an unanswered ask must not pin a turn open
    this.queue.push(CLOSE);
    this.client?.kill();
  }

  private emit(msg: SessionMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  /** Serial queue: command switches and engine turns apply in prompt order. */
  private async worker() {
    while (!this.closed) {
      const item = await this.queue.next();
      if (item === CLOSE) return;
      const trimmed = item.trim();
      if (trimmed === "/model" || trimmed.startsWith("/model ")) {
        await this.runModelCommand(trimmed.slice("/model".length).trim());
      } else if (trimmed === "/effort" || trimmed.startsWith("/effort ")) {
        await this.runEffortCommand(trimmed.slice("/effort".length).trim());
      } else {
        await this.runTurn(item);
      }
    }
  }

  /** Render Codex's own model catalog; a pick applies from the next turn. */
  private async runModelCommand(arg: string) {
    await runCodexModelCommand({
      arg,
      emit: (message) => this.emit(message),
      listModels: () => this.listModels(),
      isCurrent: (model) =>
        this.modelLabel === MODEL_STAND_IN ? model.isDefault : this.modelLabel === model.id,
      setModel: (model) => this.setModel(model),
      diagnostic: (error) => codexProviderDiagnostic(error, this.endpointForRedaction),
    });
  }

  /** An explicit model supersedes pending default-model discovery. */
  private setModel(model: string) {
    this.model = model;
    this.modelLabel = model;
    this.needsEngineDefaultModel = false;
  }

  /** Render the effort catalog; a pick applies from the next turn. */
  private async runEffortCommand(arg: string) {
    await runCodexEffortCommand({
      arg,
      emit: (message) => this.emit(message),
      discoveredLocalEndpoint: this.discoveredLocalEndpoint,
      currentEffort: this.effortLabel,
      setEffort: (effort) => {
        this.effort = effort;
        this.effortLabel = effort;
      },
    });
  }

  /** Resolve the engine's marked default before a forced first-party turn. */
  private async applyEngineDefaultModel(turn: ActiveTurn): Promise<boolean> {
    try {
      const models = await this.listEngineModels();
      if (this.closed || turn.interrupted) return false;
      this.setModel(codexEngineDefaultModel(models, this.firstPartyOpenAI));
      return true;
    } catch (err) {
      if (this.closed || turn.interrupted) return false;
      this.emit({
        type: "error",
        message:
          "This backend runs OpenAI's own provider, but its default model could not be " +
          `resolved: ${codexProviderDiagnostic(err, this.endpointForRedaction)}. ` +
          "Send `/model <model-id>` to set one.",
      });
      return false;
    }
  }

  /** The live app-server and its thread — spawned on first use, and again
   *  after the process dies (the thread resumes by id, so a crash costs the
   *  in-flight turn, never the conversation). */
  private ensureThread(): Promise<ThreadInfo> {
    if (this.threadReady && this.client && !this.client.exited) return this.threadReady;
    const client = this.makeAppServer(this.spawnSpec);
    this.client = client;
    client.onNotification((method, params) => this.onNotification(client, method, params));
    client.onServerRequest((id, method, params) => this.answerServerRequest(client, id, method, params));
    client.onExit(() => {
      if (this.client !== client) return;
      this.threadReady = undefined;
      this.activeTurn?.finish({ exited: true });
    });
    this.threadReady = (async () => {
      await client.request("initialize", {
        clientInfo: { name: "mirafold", title: "Mirafold", version: "0.0.1" },
      });
      if (this.client !== client || client.exited) {
        throw new Error("codex app-server startup was abandoned");
      }
      client.notify("initialized");
      const common = {
        cwd: this.workspaceDir,
        ...(this.model ? { model: this.model } : {}),
        // sandbox / approvalPolicy intentionally UNSET — inherited from the
        // user's own Codex config (faithful skin; see the class doc).
      };
      const response = (await (this.threadId
        ? client.request("thread/resume", { threadId: this.threadId, ...common })
        : client.request("thread/start", {
            ...common,
            developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
          }))) as { thread?: { id?: unknown }; model?: unknown };
      if (this.client !== client || client.exited) {
        throw new Error("codex app-server startup was abandoned");
      }
      const id = typeof response.thread?.id === "string" ? response.thread.id : this.threadId;
      if (!id) throw new Error("codex app-server answered thread/start without a thread id");
      this.adoptThread(id);
      const model = typeof response.model === "string" && response.model ? response.model : undefined;
      // The engine says which model it resolved; a configured label stays.
      if (model && this.modelLabel === MODEL_STAND_IN) this.modelLabel = model;
      return { id, model };
    })();
    this.threadReady.catch(() => {
      // A failed start is reported by the turn that needed it; the next turn
      // tries again from a fresh process.
      if (this.client === client) this.threadReady = undefined;
    });
    return this.threadReady;
  }

  private adoptThread(threadId: string) {
    if (this.threadId === threadId) return;
    this.threadId = threadId;
    this.resumeIdState.publish(threadId);
  }

  private onNotification(client: AppServerClient, method: string, params: unknown) {
    if (this.client !== client) return;
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "thread/started") {
      const id = (p["thread"] as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") this.adoptThread(id);
      return;
    }
    // Only this session's thread; the process is ours alone, but be exact.
    if (typeof p["threadId"] === "string" && this.threadId && p["threadId"] !== this.threadId) return;
    if (method === "turn/completed") {
      const turn = (p["turn"] ?? {}) as { id?: unknown; status?: unknown; error?: unknown };
      const active = this.activeTurn;
      if (!active) return;
      if (active.id && typeof turn.id === "string" && turn.id !== active.id) return;
      active.finish({ status: typeof turn.status === "string" ? turn.status : "completed", error: turn.error });
      return;
    }
    if (!this.activeTurn) return;
    this.eventMapper.handle(method, params);
  }

  /** The engine's own requests to its client — its approval round-trips. Each
   *  becomes a permission_request on the shell's bar; the user's answer maps
   *  back to the protocol's decision. Fail-closed on every path: a timeout, a
   *  close, or a dead process all resolve to a decline, so nothing the user
   *  didn't approve runs outside the sandbox. */
  private answerServerRequest(client: AppServerClient, id: JsonRpcId, method: string, params: unknown) {
    if (this.client !== client) return;
    const p = (params ?? {}) as Record<string, unknown>;
    const reason = typeof p["reason"] === "string" ? p["reason"] : undefined;
    const respond = (result: unknown) => {
      if (this.client === client && !client.exited) client.respond(id, result);
    };
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const command = typeof p["command"] === "string" ? p["command"] : "a command";
        // The command is ours to state plainly; the reason is the engine's own
        // explanation of the escalation ("retry outside the sandbox?").
        this.ask("Shell", reason ? `${command} — ${reason}` : command, (allow) =>
          respond({ decision: allow ? "accept" : "decline" }),
        );
        break;
      }
      case "item/fileChange/requestApproval":
        this.ask("apply_patch", reason ?? "apply this change outside the sandbox?", (allow) =>
          respond({ decision: allow ? "accept" : "decline" }),
        );
        break;
      case "item/permissions/requestApproval": {
        const permissions = (p["permissions"] ?? {}) as Record<string, unknown>;
        // The ask names what a yes GRANTS — the profile the engine wants,
        // stated by Mirafold — not only the engine's reason for wanting it:
        // an allow echoes that exact profile back, so the user must have
        // seen it (audit 2026-08-26).
        const grant = describePermissionProfile(permissions);
        this.ask("Codex", reason ? `${grant} — ${reason}` : grant, (allow) =>
          respond({ permissions: allow ? permissions : {} }),
        );
        break;
      }
      default:
        client.respondError(id, -32601, `Mirafold does not handle ${method}`);
    }
  }

  /** Raise one permission ask on the bar; `onAnswer` fires once, on any
   *  resolution path (answer, timeout, teardown — all deny but "answer"). */
  private ask(tool: string, detail: string, onAnswer: (allow: boolean) => void) {
    void this.permissions.ask({ tool, detail }, this.permissionTimeoutMs, (allow) => onAnswer(allow));
  }

  /**
   * The folder-trust gate: resolves to whether this turn may run. True once
   * the user has vouched for the workspace (or a parent) — asked once, ever,
   * through the shell's own permission strip, remembered in Mirafold's state.
   * Never blanket-trusts whatever folder is open, and never lets Codex's
   * silent config.toml trust write happen before the yes.
   */
  private ensureTrusted(): Promise<boolean> {
    if (this.trusted || isWorkspaceTrusted(this.workspaceDir, "codex")) {
      this.trusted = true;
      return Promise.resolve(true);
    }
    if (this.closed) return Promise.resolve(false);
    return this.permissions.ask(
      {
        tool: "Codex",
        detail:
          `trust this folder — ${this.workspaceDir}. ` +
          `Yes lets Codex run here (Mirafold remembers the answer); Codex may also record the folder ` +
          `as trusted in your ~/.codex/config.toml, as its terminal does when you say yes there.`,
      },
      TRUST_PROMPT_TIMEOUT_MS,
      (allow) => {
        if (allow) {
          this.trusted = true;
          trustWorkspace(this.workspaceDir, "codex"); // remembered for this disclosed effect
        }
      },
    );
  }

  private reportTurnError(error: unknown) {
    this.emit({
      type: "error",
      message: codexTurnDiagnostic(
        error,
        this.endpointForRedaction,
        this.discoveredLocalEndpoint,
      ),
    });
  }

  private async runTurn(text: string) {
    let ended = false;
    let timeoutFired = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let interruptStartup!: () => void;
    const startupInterrupted = new Promise<typeof STARTUP_INTERRUPTED>((resolve) => {
      interruptStartup = () => resolve(STARTUP_INTERRUPTED);
    });
    const turn: ActiveTurn = {
      finish: () => {},
      interrupted: false,
      interruptSent: false,
      startupInterrupted,
      interruptStartup,
    };
    const outcome = new Promise<TurnOutcome>((resolve) => {
      turn.finish = resolve;
    });
    this.activeTurn = turn;
    const end = () => {
      if (ended) return;
      ended = true;
      this.eventMapper.endTurn();
      this.emit({ type: "turn_end" });
    };
    if (this.localTurnTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (ended || this.closed) return;
        timeoutFired = true;
        this.interrupt();
      }, this.localTurnTimeoutMs);
    }
    try {
      // The trust gate runs BEFORE anything spawns: an untrusted workspace
      // can't produce a turn at all, and a denied ask leaves config.toml
      // untouched.
      const trusted = await this.awaitStartup(turn, this.ensureTrusted());
      if (trusted === STARTUP_INTERRUPTED) return;
      if (!trusted) {
        if (!this.closed && !turn.interrupted) {
          this.emit({
            type: "notice",
            text: `Codex won't run in a folder you haven't trusted. Nothing ran — send another prompt to be asked again.`,
            kind: "refusal",
          });
        }
        return;
      }
      // Stop may resolve the trust ask itself. Do not continue from any
      // startup await once this turn was abandoned.
      if (this.closed || turn.interrupted) return;
      if (this.needsEngineDefaultModel) {
        const modelReady = await this.awaitStartup(turn, this.applyEngineDefaultModel(turn));
        if (modelReady === STARTUP_INTERRUPTED || !modelReady) return;
      }
      if (this.closed || turn.interrupted) return;
      const threadPending = this.ensureThread();
      const startupClient = this.client;
      const thread = await this.awaitStartup(turn, threadPending);
      if (thread === STARTUP_INTERRUPTED) {
        this.abandonAppServer(startupClient);
        return;
      }
      if (this.closed || turn.interrupted) return;
      const client = this.client!;
      this.eventMapper.beginTurn();
      const startPending = client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text }],
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
      }) as Promise<{ turn?: { id?: unknown } }>;
      const started = await this.awaitStartup(turn, startPending);
      if (started === STARTUP_INTERRUPTED) {
        this.abandonAppServer(client);
        return;
      }
      if (typeof started.turn?.id !== "string" || !started.turn.id) {
        this.abandonAppServer(client);
        throw new Error("codex app-server answered turn/start without a turn id");
      }
      turn.id = started.turn.id;
      if (turn.interrupted) this.sendTurnInterrupt(turn);
      const result = await outcome;
      if ("exited" in result) {
        if (!this.closed && !turn.interrupted) {
          this.reportTurnError(
            client.stderrTail.trim().split("\n").at(-1) || "codex app-server exited mid-turn",
          );
        }
      } else if (result.status === "failed" && !turn.interrupted) {
        this.reportTurnError(turnErrorMessage(result.error) ?? "the turn failed");
      }
    } catch (err) {
      if (!this.closed && !turn.interrupted) {
        this.reportTurnError(err);
      }
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (turn.interruptTimer !== undefined) clearTimeout(turn.interruptTimer);
      if (!this.closed && timeoutFired) {
        this.emit({
          type: "error",
          message: codexLocalTurnTimeoutDiagnostic(this.localTurnTimeoutMs, this.effortLabel),
        });
      }
      if (this.activeTurn === turn) this.activeTurn = undefined;
      this.permissions.denyAll("moot"); // drop any ask the ended turn left open
      end(); // guarantees exactly one turn_end (interrupt, error, or normal)
    }
  }
}
