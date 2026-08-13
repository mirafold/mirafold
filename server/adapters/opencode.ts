import path from "node:path";
import { mkdirSync } from "node:fs";
import type { WireMsg } from "../protocol";
import { RENDER_GUIDANCE } from "../render-tools";
import { envInt } from "../env";
import { classifyOpenCodeProvider, type CredentialKind } from "../provider-policy";
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
  // OC.4c: the classified backend kind, published to the registry once the
  // provider verdict lands (and re-published on a /model provider switch).
  private kindListeners = new Set<(u: { kind: CredentialKind; provider?: string }) => void>();
  private lastKind?: { kind: CredentialKind; provider?: string };
  // The judged provider/model pin — every prompt carries it (OC.3).
  private modelPin?: { providerID: string; modelID: string };
  // Providers whose gray-area disclosure already ran this session — the
  // notice states standing terms, so it rides once per provider, not per turn.
  private disclosedProviders = new Set<string>();
  private permissionTimeoutMs: number;
  private pendingPermissions = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-turn end latch: exactly one turn_end per prompt (idle, error,
  // interrupt fallback, or close — whichever comes first).
  private turnActive = false;
  private turnDone?: () => void;
  private turnToken = 0;
  // Engine idles owed for turns whose send() was accepted. A turn abandoned
  // by the interrupt grace still owes one — its late idle must consume this
  // debt instead of ending the NEXT turn (bughunt round 2, reproduced).
  private pendingEngineIdles = 0;
  // Whether the ACTIVE turn's request reached the engine — an idle can only
  // end a turn whose engine work exists.
  private turnSent = false;
  // The interrupt grace timer — cleared on close so a dead session never
  // holds the event loop (ADAPTERS.md close() contract).
  private graceTimer?: ReturnType<typeof setTimeout>;

  get modelName(): string | undefined {
    return this.modelLabel;
  }

  get resumeId(): string | undefined {
    return this.resumeIdState.value;
  }

  onResumeId(cb: (id: string) => void) {
    this.resumeIdState.onChange(cb);
  }

  onBackendKind(cb: (update: { kind: CredentialKind; provider?: string }) => void) {
    this.kindListeners.add(cb);
    if (this.lastKind) cb(this.lastKind);
  }

  private publishKind(kind: CredentialKind, provider: string) {
    this.lastKind = { kind, provider };
    for (const cb of this.kindListeners) cb(this.lastKind);
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
    this.modelPin = parseModelPin(opts.model);
    // Provider-QUALIFIED, opencode's own addressing: the bare id is
    // ambiguous across providers, and the checkpointed modelName must
    // round-trip through parseModelPin on restore (bughunt 2026-08-13 —
    // a bare label silently lost the pin after recovery).
    this.modelLabel = this.modelPin
      ? `${this.modelPin.providerID}/${this.modelPin.modelID}`
      : undefined;
    this.wantedResumeId = opts.resumeId;
    this.resumeIdState = new ResumeIdState(opts.resumeId);
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
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
        // Keep the qualified form — the engine reports bare ids.
        this.modelLabel = this.modelPin ? `${this.modelPin.providerID}/${modelID}` : modelID;
      },
      onPermissionAsked: (ask) => this.onPermissionAsked(ask),
      onPermissionReplied: (requestID, reply) => this.onPermissionReplied(requestID, reply),
      onEngineIdle: () => this.onEngineIdle(),
      endTurn: () => this.endTurn(),
    });
    void this.worker();
  }

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
      // A FAILED abort must not end the turn instantly — that is the one
      // case where the engine is still generating, and freeing the worker
      // interleaves the next prompt with the live stream (bughunt
      // 2026-08-13). Both outcomes share the bounded grace: the engine's
      // own idle usually ends the turn first.
      void this.transport
        .abort(this.sessionID)
        .catch(() => {})
        .then(() => {
          this.graceTimer = setTimeout(fallback, INTERRUPT_GRACE_MS);
          this.graceTimer.unref?.();
        });
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
    clearTimeout(this.graceTimer);
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

  // Two latches, deliberately split (bughunt 2026-08-13). ENGINE: spawn +
  // event stream + command catalog — needs no pin, so `/model` can rescue a
  // pinless session instead of dying on the very policy error it exists to
  // fix. STARTED: policy + engine session on top. A policy/creation failure
  // resets only the outer latch — re-running the engine latch respawned a
  // fresh `opencode serve` per retry, orphaning the previous server and
  // doubling the event pump.
  private engineUp?: Promise<void>;

  private ensureEngine(): Promise<void> {
    this.engineUp ??= (async () => {
      await this.transport.start(
        (ev) => this.handleEvent(ev),
        (detail) => this.onEngineDied(detail),
      );
      // Non-fatal fidelity: without the catalog, `/name` inputs simply reach
      // the model as prompt text and the options list shows only our rows.
      this.engineCommands = await this.transport.commandCatalog().catch(() => []);
    })();
    return this.engineUp.catch((err) => {
      // Only a failed ENGINE start may retry the spawn; the transport keeps
      // its own idempotence guard for the crossing-calls case.
      this.engineUp = undefined;
      throw err;
    });
  }

  /** Lazily on the first turn; a failure resets the outer latch so a later
   *  prompt retries (the user may have installed the binary, connected a
   *  provider, or pinned a model meanwhile). */
  private ensureStarted(): Promise<void> {
    this.started ??= (async () => {
      await this.ensureEngine();
      if (this.closed) throw new Error("session closed");
      await this.enforceProviderPolicy();
      if (this.wantedResumeId && (await this.transport.sessionExists(this.wantedResumeId))) {
        this.sessionID = this.wantedResumeId;
      } else {
        this.sessionID = (await this.transport.createSession()).id;
      }
      this.resumeIdState.publish(this.sessionID);
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
          "the provider determines whether the session may run at all. The built-in free " +
          "models work too, e.g. OPENCODE_MODEL=opencode/big-pickle",
      );
    }
    const reason = await this.adoptPin(pin);
    if (reason) throw new Error(reason);
  }

  /** Classify `pin`, and on an allowed verdict make it THIS session's pin:
   *  publish the truthful kind to the registry (OC.4c — the relay gate's
   *  input) and emit the gray-area disclosure when the provider carries one.
   *  Returns the refusal reason instead when the pin may not run — the
   *  shared verdict behind session start and a `/model` switch. */
  private async adoptPin(pin: {
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
    this.modelPin = pin;
    this.modelLabel = `${pin.providerID}/${pin.modelID}`;
    this.publishKind(verdict.kind, pin.providerID);
    if (verdict.disclosure && !this.disclosedProviders.has(pin.providerID)) {
      this.disclosedProviders.add(pin.providerID);
      // Mirafold-composed (no source badge): the disclosed-uncertainty
      // rule's required disclosure — uncertainty stated, never permission.
      this.emit({ type: "notice", text: verdict.disclosure });
    }
    return undefined;
  }

  refreshPromptOptions() {
    refreshOpenCodePromptOptions({
      emit: (msg) => this.emit(msg),
      isClosed: () => this.closed,
      listCommands: async () => {
        await this.ensureEngine();
        return this.engineCommands;
      },
    });
  }

  /** One engine turn's envelope: token, mapper reset, the done-latch, and
   *  the shared failure path — `runTurn` and `runEngineCommand` differ only
   *  in the request they send once the engine is up. */
  private async runEngineTurn(send: () => Promise<void>) {
    const token = ++this.turnToken;
    this.turnActive = true;
    this.turnSent = false;
    this.mapper.startTurn();
    const done = new Promise<void>((resolve) => {
      this.turnDone = resolve;
    });
    try {
      await this.ensureStarted();
      // An interrupt during startup already ended this turn — sending now
      // would run a GHOST turn outside any envelope: its stream interleaves
      // with the next prompt and its eventual idle ends the wrong turn
      // (bughunt 2026-08-13). The guidance flag is untouched too, so the
      // first REAL turn still carries it.
      if (!this.turnActive || this.turnToken !== token) return;
      await send();
      // The engine accepted the request: exactly one idle is now owed, and
      // only from here can an idle legitimately end this turn.
      this.pendingEngineIdles += 1;
      if (this.turnToken === token) this.turnSent = true;
      await done;
    } catch (err) {
      // Token-guarded: a send that fails AFTER the grace fallback already
      // ended this turn must not error-and-end whatever turn now runs.
      if (this.turnActive && this.turnToken === token) {
        if (!this.closed) this.emit({ type: "error", message: errText(err) });
        this.endTurn();
      }
    }
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
        // Slash-shaped input: the catalog decides whether it is an engine
        // command — and a RESTORED session replays checkpointed command
        // options before its engine has started, so the catalog must be
        // loaded first or an advertised `/init` would reach the model as
        // prose (bughunt round 2; ADAPTERS.md's interception rule). A
        // failed engine start falls back to the prompt path, whose own
        // error surfacing covers it.
        if (/^\/[\w:-]/.test(trimmed) && this.engineCommands.length === 0) {
          await this.ensureEngine().catch(() => {});
        }
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
        await this.ensureEngine();
        // Every ALLOWED provider rows here — gray areas included, since
        // OC.4c flows their true kind to the registry and their disclosure
        // rides the pick (the picker offers only what a pick can run).
        const allowed = new Set(
          (await this.transport.providerCatalog())
            .filter((entry) => classifyOpenCodeProvider(entry).allowed)
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
          // Engine latch only: `/model` must be able to RESCUE a pinless
          // session, and ensureStarted's policy gate throws exactly the
          // no-pin error this command exists to fix (bughunt 2026-08-13).
          await this.ensureEngine();
          return await this.adoptPin(pin);
        } catch (err) {
          return errText(err);
        }
      },
    });
  }

  private async runAgentCommand(arg: string) {
    await runOpenCodeAgentCommand({
      arg,
      emit: (msg) => this.emit(msg),
      listAgents: async () => {
        await this.ensureEngine();
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
  private runEngineCommand(name: string, args: string): Promise<void> {
    return this.runEngineTurn(() =>
      this.transport.command(this.sessionID as string, name, args, {
        ...(this.modelPin ? { model: `${this.modelPin.providerID}/${this.modelPin.modelID}` } : {}),
        ...(this.currentAgent ? { agent: this.currentAgent } : {}),
      }),
    );
  }

  private runTurn(text: string): Promise<void> {
    return this.runEngineTurn(async () => {
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
    });
  }

  /** The engine PROCESS died after a successful start (crash, OOM, kill).
   *  Surface it, end any live turn, and reset the latches so the next
   *  prompt respawns a fresh engine — without this the session stayed
   *  busy-wedged forever (bughunt round 2). */
  private onEngineDied(detail: string) {
    if (this.closed) return;
    this.engineUp = undefined;
    this.started = undefined;
    this.sessionID = undefined;
    this.pendingEngineIdles = 0;
    this.denyPendingPermissions(false);
    this.emit({ type: "error", message: detail });
    this.endTurn();
  }

  /** One engine idle arrived. It ends the ACTIVE turn only when that turn's
   *  own request is what just finished — a stale idle from an abandoned turn
   *  pays down the debt and nothing more. */
  private onEngineIdle() {
    if (this.pendingEngineIdles > 0) this.pendingEngineIdles -= 1;
    if (this.turnActive && this.turnSent && this.pendingEngineIdles === 0) this.endTurn();
  }

  private endTurn() {
    if (!this.turnActive) return;
    this.turnActive = false;
    // A turn's end moots its gated asks: without this, a stale
    // permission_resolved fired up to PERMISSION_TIMEOUT_MS later, mid-next-
    // turn (bughunt). No engine reply — the engine has already moved on.
    this.denyPendingPermissions(false);
    // Usage flushes inside the end path — one per completed turn, just
    // before turn_end, never between turns (bughunt round 2).
    if (!this.closed) this.mapper.flushUsage();
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

  private denyPendingPermissions(replyToEngine = true) {
    for (const [id, timer] of [...this.pendingPermissions])
      this.resolvePermissionInternal(id, false, timer, replyToEngine);
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

