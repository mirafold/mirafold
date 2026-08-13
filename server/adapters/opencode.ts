import path from "node:path";
import { mkdirSync } from "node:fs";
import type { WireMsg } from "../protocol";
import { RENDER_GUIDANCE } from "../render-tools";
import { envInt } from "../env";
import { classifyOpenCodeProvider } from "../provider-policy";
import { agentBin, errText, PERMISSION_TIMEOUT_MS, type AgentSession } from "./types";
import { AsyncQueue, CLOSE } from "./async-queue";
import { ResumeIdState } from "./resume-id";
import { renderMcpCommand, MIRAFOLD_MCP } from "./render-mcp-cmd";
import {
  OpenCodeServerProcess,
  type OpenCodeCommandEntry,
  type OpenCodeEvent,
  type OpenCodeTransport,
} from "./opencode-client";
import { OpenCodeEventMapper } from "./opencode-events";
import {
  OPENCODE_DEFAULT_AGENT,
  refreshOpenCodePromptOptions,
  runOpenCodeAgentCommand,
  runOpenCodeModelCommand,
} from "./opencode-commands";

// An aborted turn normally ends via the engine's own `session.idle`; this is
// the honest fallback if that event never comes, so an interrupt can't wedge
// the serial prompt queue forever.
const INTERRUPT_GRACE_MS = envInt("MIRAFOLD_OPENCODE_INTERRUPT_GRACE_MS", 5_000);

/**
 * The OpenCode adapter: the opencode engine driven through its own
 * `opencode serve` HTTP + SSE surface (raw, no SDK — see opencode-client.ts),
 * one server per session, project-scoped by the session's cwd.
 *
 * Faithful-skin posture: we pass only Mirafold's genuine concerns — the
 * working directory and, when configured, a `provider/model` pin per prompt.
 * The user's own OpenCode config (their MCP servers, permission rules,
 * custom agents) loads untouched; the render MCP arrives additively via
 * OPENCODE_CONFIG_CONTENT, never by writing a file they own. Permission asks
 * bridge to the shell's bar and are answered `once`/`reject` — never
 * `always`, which would persist an approval into their own OpenCode state.
 */
export class OpenCodeSession implements AgentSession {
  private queue = new AsyncQueue<string | typeof CLOSE>();
  private listeners = new Set<(msg: WireMsg) => void>();
  private workspaceDir: string;
  private transport: OpenCodeTransport;
  private mapper: OpenCodeEventMapper;
  private resumeIdState: ResumeIdState;
  private sessionID?: string;
  private wantedResumeId?: string;
  private started?: Promise<void>;
  private closed = false;
  private firstTurn = true;
  private modelLabel?: string;
  // The picked OpenCode agent (build/plan/custom primary); unset = the
  // engine's own default rides (no `agent` field on prompts).
  private currentAgent?: string;
  // The engine's command catalog, learned at start — routes `/name` inputs
  // to the engine's dispatcher and feeds the prompt-options catalog.
  private engineCommands: OpenCodeCommandEntry[] = [];
  private permissionTimeoutMs: number;
  private pendingPermissions = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-turn end latch: exactly one turn_end per prompt (idle, error,
  // interrupt fallback, or close — whichever comes first).
  private turnActive = false;
  private turnDone?: () => void;
  private turnToken = 0;

  get modelName(): string | undefined {
    return this.modelLabel;
  }

  get resumeId(): string | undefined {
    return this.resumeIdState.value;
  }

  onResumeId(cb: (id: string) => void) {
    this.resumeIdState.onChange(cb);
  }

  // `makeTransport` and `permissionTimeoutMs` are test seams.
  constructor(opts: {
    workspaceDir: string;
    model?: string;
    resumeId?: string;
    makeTransport?: (config: Record<string, unknown>) => OpenCodeTransport;
    permissionTimeoutMs?: number;
  }) {
    const workspaceDir = path.resolve(opts.workspaceDir);
    mkdirSync(workspaceDir, { recursive: true });
    this.workspaceDir = workspaceDir;
    this.modelLabel = modelIdOf(opts.model);
    this.wantedResumeId = opts.resumeId;
    this.resumeIdState = new ResumeIdState(opts.resumeId);
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
    this.modelPin = parseModelPin(opts.model);
    const render = renderMcpCommand();
    const configContent = {
      mcp: {
        [MIRAFOLD_MCP]: {
          type: "local",
          command: [render.command, ...render.args],
          enabled: true,
        },
      },
    };
    this.transport =
      opts.makeTransport?.(configContent) ??
      new OpenCodeServerProcess({
        bin: agentBin("OPENCODE_BIN", "opencode"),
        cwd: workspaceDir,
        configContent,
      });
    this.mapper = new OpenCodeEventMapper({
      emit: (msg) => this.emit(msg),
      workspaceDir,
      isOurs: (id) => this.sessionID !== undefined && id === this.sessionID,
      learnModel: (modelID) => {
        this.modelLabel = modelID;
      },
      onPermissionAsked: (ask) => this.onPermissionAsked(ask),
      onPermissionReplied: (requestID, reply) => this.onPermissionReplied(requestID, reply),
      endTurn: () => this.endTurn(),
    });
    void this.worker();
  }

  private modelPin?: { providerID: string; modelID: string };

  pushPrompt(text: string) {
    if (!this.closed) this.queue.push(text);
  }

  onMessage(cb: (msg: WireMsg) => void) {
    this.listeners.add(cb);
  }

  interrupt() {
    if (!this.turnActive) return;
    const token = this.turnToken;
    this.denyPendingPermissions();
    const fallback = () => {
      if (this.turnActive && this.turnToken === token) this.endTurn();
    };
    if (this.sessionID) {
      void this.transport
        .abort(this.sessionID)
        .catch(() => fallback())
        .then(() => setTimeout(fallback, INTERRUPT_GRACE_MS));
    } else {
      fallback();
    }
  }

  resolvePermission(id: string, allow: boolean) {
    const timer = this.pendingPermissions.get(id);
    if (timer === undefined) return; // stale/unknown — already resolved
    this.resolvePermissionInternal(id, allow, timer, true);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.denyPendingPermissions();
    this.endTurn(); // release a worker awaiting an in-flight turn
    this.transport.close();
    this.queue.push(CLOSE);
  }

  private emit(msg: WireMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  private handleEvent(ev: OpenCodeEvent) {
    if (!this.closed) this.mapper.handle(ev);
  }

  /** Spawn/attach lazily on the first turn; a failure resets the latch so a
   *  later prompt retries (the user may have installed the binary, connected
   *  a provider, or pinned a model meanwhile). */
  private ensureStarted(): Promise<void> {
    this.started ??= (async () => {
      await this.transport.start((ev) => this.handleEvent(ev));
      await this.enforceProviderPolicy();
      if (this.wantedResumeId && (await this.transport.sessionExists(this.wantedResumeId))) {
        this.sessionID = this.wantedResumeId;
      } else {
        this.sessionID = (await this.transport.createSession()).id;
      }
      this.resumeIdState.publish(this.sessionID);
      // Non-fatal fidelity: without the catalog, `/name` inputs simply reach
      // the model as prompt text and the options list shows only our rows.
      this.engineCommands = await this.transport.commandCatalog().catch(() => []);
    })();
    return this.started.catch((err) => {
      this.started = undefined;
      throw err;
    });
  }

  /** The R.4i gate, provider-resolved (PLAN OC.3): every turn of this session
   *  runs on the pinned provider (we set `model` on each prompt), so the pin
   *  is what the policy judges — classified from the running engine's own
   *  catalog, never from the user's auth.json. Refusals throw; the message
   *  travels the honest per-turn error path and names the fix. */
  private async enforceProviderPolicy(): Promise<void> {
    const pin = this.modelPin ?? parseModelPin(await this.transport.configModel());
    if (!pin) {
      throw new Error(
        "no model is pinned for this OpenCode session — set OPENCODE_MODEL=<provider>/<model> " +
          "(or `model` in your opencode config) so Mirafold knows which provider will run; " +
          "the provider determines whether the session may run at all",
      );
    }
    const reason = await this.pinRefusalReason(pin);
    if (reason) throw new Error(reason);
    this.modelPin = pin;
    this.modelLabel ??= pin.modelID;
  }

  /** Why `pin` may not run, or undefined when it may — the shared verdict
   *  behind session start and a `/model` switch (a switch must never reach a
   *  provider the start gate would have refused). */
  private async pinRefusalReason(pin: {
    providerID: string;
    modelID: string;
  }): Promise<string | undefined> {
    const entry = (await this.transport.providerCatalog()).find((p) => p.id === pin.providerID);
    if (!entry) {
      return (
        `provider "${pin.providerID}" isn't connected in opencode — connect it with ` +
        "`opencode auth login` (or declare it in your opencode config), then prompt again"
      );
    }
    const verdict = classifyOpenCodeProvider(entry);
    if (!verdict.allowed) return verdict.reason ?? "provider refused by policy";
    if (verdict.kind === "subscription") {
      // The ChatGPT gray area needs the classified kind to flow into the
      // session's Backend before it may run (the relay gate reads
      // Backend.kind, and this session was resolved optimistically as
      // api-key) — that wiring plus the required disclosure is PLAN OC.4b.
      // Until then the gray path refuses honestly rather than run under a
      // kind that would overstate its relay rights.
      return (
        "a ChatGPT login through OpenCode isn't wired up in Mirafold yet — " +
        "connect OpenAI (or another provider) with an API key in opencode to run this session"
      );
    }
    return undefined;
  }

  refreshPromptOptions() {
    refreshOpenCodePromptOptions({
      emit: (msg) => this.emit(msg),
      isClosed: () => this.closed,
      listCommands: async () => {
        await this.ensureStarted();
        return this.engineCommands;
      },
    });
  }

  /** Serial queue: command switches and engine turns apply in prompt order. */
  private async worker() {
    while (!this.closed) {
      const item = await this.queue.next();
      if (item === CLOSE) return;
      const trimmed = item.trim();
      if (trimmed === "/model" || trimmed.startsWith("/model ")) {
        await this.runModelCommand(trimmed.slice("/model".length).trim());
      } else if (trimmed === "/agent" || trimmed.startsWith("/agent ")) {
        await this.runAgentCommand(trimmed.slice("/agent".length).trim());
      } else {
        const engine = this.matchEngineCommand(trimmed);
        if (engine) await this.runEngineCommand(engine.name, engine.args);
        else await this.runTurn(item);
      }
    }
  }

  /** `/name [args]` for a name in the engine's own catalog. Known only once
   *  the engine started — a cold session's very first input routes as prompt
   *  text instead (rare; the model still sees exactly what was typed). */
  private matchEngineCommand(trimmed: string): { name: string; args: string } | undefined {
    const match = /^\/([\w:-]+)(?:\s+([^]*))?$/.exec(trimmed);
    if (!match) return undefined;
    const name = match[1];
    if (!this.engineCommands.some((c) => c.name === name)) return undefined;
    return { name, args: (match[2] ?? "").trim() };
  }

  private async runModelCommand(arg: string) {
    await runOpenCodeModelCommand({
      arg,
      emit: (msg) => this.emit(msg),
      listModels: async () => {
        await this.ensureStarted();
        const allowed = new Set(
          (await this.transport.providerCatalog())
            .filter((entry) => {
              const verdict = classifyOpenCodeProvider(entry);
              // The gray subscription is excluded with the blocked rows: the
              // picker offers only what a pick can actually run (OC.4b).
              return verdict.allowed && verdict.kind !== "subscription";
            })
            .map((entry) => entry.id),
        );
        return (await this.transport.modelCatalog()).filter((m) => allowed.has(m.providerID));
      },
      isCurrent: (providerID, modelID) =>
        this.modelPin?.providerID === providerID && this.modelPin?.modelID === modelID,
      setModel: async (id) => {
        const pin = parseModelPin(id);
        if (!pin) return "Usage: `/model` to pick, or `/model <provider>/<model>`.";
        try {
          await this.ensureStarted();
          const reason = await this.pinRefusalReason(pin);
          if (reason) return reason;
        } catch (err) {
          return errText(err);
        }
        this.modelPin = pin;
        this.modelLabel = pin.modelID;
        return undefined;
      },
    });
  }

  private async runAgentCommand(arg: string) {
    await runOpenCodeAgentCommand({
      arg,
      emit: (msg) => this.emit(msg),
      listAgents: async () => {
        await this.ensureStarted();
        return this.transport.agentCatalog();
      },
      currentAgent: this.currentAgent ?? OPENCODE_DEFAULT_AGENT,
      setAgent: (name) => {
        this.currentAgent = name;
      },
    });
  }

  /** An engine command runs as a full turn: same envelope, same event flow —
   *  the engine's own dispatcher does the work (`/init`, custom commands). */
  private async runEngineCommand(name: string, args: string) {
    this.turnToken += 1;
    this.turnActive = true;
    this.mapper.startTurn();
    const done = new Promise<void>((resolve) => {
      this.turnDone = resolve;
    });
    try {
      await this.ensureStarted();
      await this.transport.command(this.sessionID as string, name, args, {
        ...(this.modelPin ? { model: `${this.modelPin.providerID}/${this.modelPin.modelID}` } : {}),
        ...(this.currentAgent ? { agent: this.currentAgent } : {}),
      });
      await done;
    } catch (err) {
      if (!this.closed) this.emit({ type: "error", message: errText(err) });
      this.endTurn();
    }
  }

  private async runTurn(text: string) {
    this.turnToken += 1;
    this.turnActive = true;
    this.mapper.startTurn();
    const done = new Promise<void>((resolve) => {
      this.turnDone = resolve;
    });
    try {
      await this.ensureStarted();
      const prompt = this.firstTurn ? `${RENDER_GUIDANCE}\n\n---\n\n${text}` : text;
      await this.transport.prompt(this.sessionID as string, {
        parts: [{ type: "text", text: prompt }],
        ...(this.modelPin ? { model: this.modelPin } : {}),
        ...(this.currentAgent ? { agent: this.currentAgent } : {}),
      });
      // Flipped only once the engine ACCEPTED the prompt: flipping before the
      // await burns the guidance on a failed first turn and every later turn
      // runs bare (the codex adapter's 2026-07-29 lesson, inherited).
      this.firstTurn = false;
      await done;
    } catch (err) {
      if (!this.closed) this.emit({ type: "error", message: errText(err) });
      this.endTurn();
    }
  }

  private endTurn() {
    if (!this.turnActive) return;
    this.turnActive = false;
    this.mapper.endTurn();
    if (!this.closed) this.emit({ type: "turn_end" });
    this.turnDone?.();
    this.turnDone = undefined;
  }

  private onPermissionAsked(ask: { id: string; permission: string; detail: string }) {
    if (this.closed || this.pendingPermissions.has(ask.id)) return;
    // Deny-by-default: an unanswered ask must not pin the turn open forever.
    const timer = setTimeout(() => {
      const pending = this.pendingPermissions.get(ask.id);
      if (pending !== undefined) this.resolvePermissionInternal(ask.id, false, pending, true);
    }, this.permissionTimeoutMs);
    this.pendingPermissions.set(ask.id, timer);
    this.emit({ type: "permission_request", tool: ask.permission, detail: ask.detail, id: ask.id });
  }

  /** protocol.ts contract: permission_request MUST resolve visibly on EVERY
   *  path — browser answer, timeout, external reply, interrupt, close. */
  private resolvePermissionInternal(
    id: string,
    allow: boolean,
    timer: ReturnType<typeof setTimeout>,
    replyToEngine: boolean,
  ) {
    clearTimeout(timer);
    this.pendingPermissions.delete(id);
    if (replyToEngine && this.sessionID) {
      void this.transport
        .replyPermission(this.sessionID, id, allow ? "once" : "reject")
        .catch((err) => {
          if (!this.closed)
            this.emit({ type: "error", message: `permission reply failed: ${errText(err)}` });
        });
    }
    if (!this.closed) this.emit({ type: "permission_resolved", id, allow });
  }

  /** The stream reported a reply we didn't send (another attached client). */
  private onPermissionReplied(requestID: string, reply: string) {
    const timer = this.pendingPermissions.get(requestID);
    if (timer === undefined) return; // our own echo — already resolved
    this.resolvePermissionInternal(requestID, reply !== "reject", timer, false);
  }

  private denyPendingPermissions() {
    for (const [id, timer] of [...this.pendingPermissions])
      this.resolvePermissionInternal(id, false, timer, true);
  }
}

/** A configured model pin. OpenCode addresses models as `provider/model`
 *  (the id itself may contain further slashes); a bare value can't name a
 *  provider, so it pins nothing and the user's own config default is
 *  resolved instead — inherit, never invent. Exported for the registry's
 *  `Backend.provider` resolution. */
export function parseModelPin(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/** The label half of a pin, for `modelName` before the engine reports. */
function modelIdOf(model?: string): string | undefined {
  return parseModelPin(model)?.modelID;
}
