import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import {
  type Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type Thread,
} from "@openai/codex-sdk";
import type { WireMsg } from "../protocol";
import { RENDER_GUIDANCE } from "../render-tools";
import type { AgentSession } from "./types";
import type { CodexModel } from "./codex-model-list";
import { AsyncQueue, CLOSE } from "./async-queue";
import { listCodexSkills, type CodexSkill } from "./codex-skills-list";
import { ResumeIdState } from "./resume-id";
import { envInt } from "../env";
import {
  codexEngineDefaultModel,
  createCodexRuntimeBinding,
  type CodexBackendKind,
} from "./codex-binding";
import { CODEX_DEFERRED_TOOLS_ADDENDUM } from "./codex-prompt";
import { CodexRolloutLookup } from "./codex-rollout";
import {
  CODEX_EFFORT_STAND_IN,
  refreshCodexPromptOptions,
  runCodexEffortCommand,
  runCodexModelCommand,
  type CodexReasoningEffort,
} from "./codex-commands";
import { CodexEventMapper } from "./codex-events";
import {
  codexLocalTurnTimeoutDiagnostic,
  codexProviderDiagnostic,
  codexTurnDiagnostic,
} from "./codex-diagnostics";

export { CODEX_DEFERRED_TOOLS_ADDENDUM } from "./codex-prompt";
export { resolveRolloutModel, rolloutDateDir } from "./codex-rollout";
export { extractRenderId, mcpText } from "./codex-events";

// Internal-only sentinel while the rollout lookup discovers Codex's default;
// `modelName` withholds it so the UI never presents a false model name.
const MODEL_STAND_IN = "codex";

// Discovered local endpoints need one outer turn bound because Codex's own
// retry policy can otherwise stay silent for minutes. Zero opts out.
const DEFAULT_LOCAL_TURN_TIMEOUT_MS = envInt(
  "MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS",
  8 * 60_000,
);

/**
 * The Codex adapter: OpenAI's Codex, driven through its own `@openai/codex-sdk`
 * engine. One persistent `Thread` carries the warm conversation across turns;
 * its events are normalized into the shared `WireMsg` union.
 *
 * Faithful-skin posture (see the inherit-don't-invent principle): this adapter
 * passes ONLY Mirafold's genuine concerns — the session working directory
 * (session ≈ project) and the model when configured. It sets no
 * `sandboxMode`/`approvalPolicy`, preserving the user's own Codex config.
 * Codex's SDK exposes no interactive-approval callback, so `permission_request`
 * simply never fires here (optional-feature rule); resolvePermission is a no-op.
 */
export class CodexSession implements AgentSession {
  private queue = new AsyncQueue<string | typeof CLOSE>();
  private listeners = new Set<(msg: WireMsg) => void>();
  private workspaceDir: string;
  private thread: Thread;
  // A model/effort switch resumes this same warm conversation with new options.
  private codex: Codex;
  private threadOpts: {
    workingDirectory: string;
    skipGitRepoCheck: true;
    model?: string;
    modelReasoningEffort?: ModelReasoningEffort;
  };
  private threadId?: string;
  private resumeIdState: ResumeIdState;
  private listModels: () => Promise<CodexModel[]>;
  private closed = false;
  private currentAbort?: AbortController;
  private eventMapper: CodexEventMapper;
  private modelLabel: string;
  // The config/model default stays in force until `/effort` overrides it.
  private effortLabel: string = CODEX_EFFORT_STAND_IN;
  // Kept mutable so rollout tests can point the lookup at a fixture.
  private codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  private rolloutLookup = new CodexRolloutLookup();
  // The SDK has no instructions hook, so guidance rides on the first turn.
  private firstTurn = true;
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

  get modelName(): string | undefined {
    return this.modelLabel === MODEL_STAND_IN ? undefined : this.modelLabel;
  }

  get resumeId(): string | undefined {
    return this.threadId;
  }

  onResumeId(cb: (id: string) => void) {
    this.resumeIdState.onChange(cb, this.threadId);
  }

  // `makeCodex` and the catalog functions are constructor-level test seams.
  constructor(opts: {
    workspaceDir: string;
    model?: string;
    kind?: CodexBackendKind;
    endpoint?: string;
    provider?: string;
    resumeId?: string;
    makeCodex?: (options: CodexOptions) => Codex;
    listModels?: () => Promise<CodexModel[]>;
    listEngineModels?: () => Promise<CodexModel[]>;
    listSkills?: () => Promise<CodexSkill[]>;
    /** Unit-test seam; production uses MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS. */
    localTurnTimeoutMs?: number;
  }) {
    const workspaceDir = path.resolve(opts.workspaceDir);
    mkdirSync(workspaceDir, { recursive: true });
    this.workspaceDir = workspaceDir;
    this.modelLabel = opts.model ?? MODEL_STAND_IN;
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
      makeCodex: opts.makeCodex,
      listModels: opts.listModels,
      listEngineModels: opts.listEngineModels,
    });
    const codex = runtime.codex;
    this.codex = codex;
    this.firstPartyOpenAI = runtime.firstPartyOpenAI;
    this.endpointForRedaction = runtime.endpointForRedaction;
    this.threadId = opts.resumeId;
    this.resumeIdState = new ResumeIdState(opts.resumeId);
    this.eventMapper = new CodexEventMapper({
      emit: (message) => this.emit(message),
      workspaceDir,
      modelName: () => this.modelName,
      modelUnknown: () => this.modelLabel === MODEL_STAND_IN,
      learnModel: () => void this.learnModel(),
      turnDiagnostic: (value) =>
        codexTurnDiagnostic(value, this.endpointForRedaction, this.discoveredLocalEndpoint),
      providerDiagnostic: (value) => codexProviderDiagnostic(value, this.endpointForRedaction),
      onThreadStarted: (threadId) => {
        if (this.threadId === threadId) return;
        this.threadId = threadId;
        this.resumeIdState.publish(threadId);
      },
    });
    this.listModels = runtime.listModels;
    this.listEngineModels = runtime.listEngineModels;
    this.listSkills =
      opts.listSkills ?? (() => listCodexSkills(workspaceDir, undefined, runtime.engineBin));
    this.needsEngineDefaultModel = runtime.needsEngineDefaultModel;
    this.threadOpts = {
      workingDirectory: workspaceDir,
      skipGitRepoCheck: true, // workspace dirs aren't git repos
      ...(opts.model ? { model: opts.model } : {}),
      // sandboxMode / approvalPolicy intentionally UNSET — inherited from the
      // user's own Codex config (faithful skin; see the class doc).
    };
    this.thread = this.threadId
      ? codex.resumeThread(this.threadId, this.threadOpts)
      : codex.startThread(this.threadOpts);
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

  onMessage(cb: (msg: WireMsg) => void) {
    this.listeners.add(cb);
  }

  interrupt() {
    // Abort the in-flight turn; the thread stays warm for the next prompt.
    this.currentAbort?.abort();
  }

  // Codex's SDK has no interactive-approval callback (approvals are governed by
  // the inherited sandbox/approval config), so no browser prompt is ever
  // pending — nothing to resolve.
  resolvePermission(_id: string, _allow: boolean) {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.currentAbort?.abort();
    this.queue.push(CLOSE);
  }

  private emit(msg: WireMsg) {
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

  /** Render Codex's own model catalog, then resume the warm thread on a pick. */
  private async runModelCommand(arg: string) {
    await runCodexModelCommand({
      arg,
      emit: (message) => this.emit(message),
      listModels: () => this.listModels(),
      isCurrent: (model) =>
        this.modelLabel === MODEL_STAND_IN ? model.isDefault : this.modelLabel === model.id,
      setModel: (model) => this.setThreadModel(model),
      diagnostic: (error) => codexProviderDiagnostic(error, this.endpointForRedaction),
    });
  }

  /** An explicit model supersedes pending default-model discovery. */
  private setThreadModel(model: string) {
    this.threadOpts = { ...this.threadOpts, model };
    this.restartThread();
    this.modelLabel = model;
    this.needsEngineDefaultModel = false;
  }

  /** Apply current options without discarding a started thread's history. */
  private restartThread() {
    this.thread = this.threadId
      ? this.codex.resumeThread(this.threadId, this.threadOpts)
      : this.codex.startThread(this.threadOpts);
  }

  /** Render the effort catalog and resume the warm thread on a pick. */
  private async runEffortCommand(arg: string) {
    await runCodexEffortCommand({
      arg,
      emit: (message) => this.emit(message),
      discoveredLocalEndpoint: this.discoveredLocalEndpoint,
      currentEffort: this.effortLabel,
      setEffort: (effort) => this.setThreadEffort(effort),
    });
  }

  /** Switch effort while preserving the warm thread's history. */
  private setThreadEffort(effort: CodexReasoningEffort) {
    // Codex 0.147.0 accepts and forwards `none`; the SDK union has not caught
    // up. Keep the cast at this single boundary instead of widening every
    // ThreadOptions use in the adapter.
    this.threadOpts = {
      ...this.threadOpts,
      modelReasoningEffort: effort as ModelReasoningEffort,
    };
    this.restartThread();
    this.effortLabel = effort;
  }

  /** Resolve the engine's marked default before a forced first-party turn. */
  private async applyEngineDefaultModel(): Promise<boolean> {
    try {
      const models = await this.listEngineModels();
      this.setThreadModel(codexEngineDefaultModel(models, this.firstPartyOpenAI));
      return true;
    } catch (err) {
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

  private async runTurn(text: string) {
    const abort = new AbortController();
    this.currentAbort = abort;
    let ended = false;
    let timeoutFired = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
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
        abort.abort();
      }, this.localTurnTimeoutMs);
    }
    try {
      if (this.needsEngineDefaultModel && !(await this.applyEngineDefaultModel())) return;
      const prompt = this.firstTurn
        ? `${RENDER_GUIDANCE}\n${CODEX_DEFERRED_TOOLS_ADDENDUM}\n\n---\n\n${text}`
        : text;
      const { events } = await this.thread.runStreamed(prompt, { signal: abort.signal });
      // Consumed only once the engine ACCEPTED the prompt: flipping before
      // the await meant a failed first turn (spawn failure, immediate
      // reject) burned the guidance undelivered, and every later turn ran
      // bare — no render calls for the session's whole life (2026-07-29
      // bughunt; V.2 measured 0/9 render calls without the addendum).
      this.firstTurn = false;
      for await (const event of events) this.eventMapper.handle(event, end);
    } catch (err) {
      if (!this.closed && timeoutFired) {
        this.emit({
          type: "error",
          message: codexLocalTurnTimeoutDiagnostic(this.localTurnTimeoutMs, this.effortLabel),
        });
      } else if (!this.closed && !abort.signal.aborted) {
        this.emit({
          type: "error",
          message: codexTurnDiagnostic(
            err,
            this.endpointForRedaction,
            this.discoveredLocalEndpoint,
          ),
        });
      }
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      end(); // guarantees exactly one turn_end (interrupt, error, or normal)
      if (this.currentAbort === abort) this.currentAbort = undefined;
    }
  }

  private learnModel() {
    return this.rolloutLookup.learn({
      threadId: () => this.threadId,
      codexHome: () => this.codexHome,
      shouldContinue: () => !this.closed && this.modelLabel === MODEL_STAND_IN,
      onResolved: (model) => {
        this.modelLabel = model;
      },
    });
  }
}
