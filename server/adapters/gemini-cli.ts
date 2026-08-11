import path from "node:path";
import { createLogger, verbose } from "../log";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { PromptOption, WireMsg } from "../protocol";
import { RENDER_GUIDANCE } from "../render-tools";
import { type AgentSession, capOutput, emitPromptOptions, errText, toolDetail } from "./types";
import { MIRAFOLD_MCP, RENDER_ID_RE, generativeUIMsg, renderMcpCommand } from "./render-mcp-cmd";
import { geminiBin, listGeminiModels, type GeminiModelCatalog } from "./gemini-model-list";
import { emitModelPicker } from "./model-picker";
import { isWorkspaceTrusted, trustWorkspace } from "../sessions/workspace-trust";
import { AsyncQueue, CLOSE } from "./async-queue";
import { ResumeIdState } from "./resume-id";

// Same generative-UI stdio MCP server the Codex adapter injects (P.3). Gemini
// loads MCP servers from settings.json, so we write a per-session project
// `.gemini/settings.json` naming it (merged over the user's global config).
const RENDER_MCP = renderMcpCommand();
// Gemini names MCP tools `mcp_<server>_<tool>`; ours therefore start with this.
const MCP_PREFIX = `mcp_${MIRAFOLD_MCP}_`;
// How much of a failed turn's stderr rides into the surfaced error (F.4).
const STDERR_TAIL_CAP = 4000;
// How long the folder-trust ask waits for an answer before denying (P.6b) —
// the same posture as Claude's permission prompt: an unanswered ask must not
// pin a turn open forever.
const TRUST_PROMPT_TIMEOUT_MS = 5 * 60_000;
// Gemini CLI's ExitCodes.FATAL_INPUT_ERROR — the exit for an unusable
// `--resume`/`--session-id` id, thrown in resolveSessionId() before any
// stdout event (verified against v0.51.0, 2026-07-23).
const GEMINI_FATAL_INPUT_ERROR = 42;

/** The component id the render-mcp stub returned, parsed from its output text. */
export function parseRenderId(output: unknown): string {
  const m = String(output ?? "").match(RENDER_ID_RE);
  return m ? m[1] : randomUUID();
}

/**
 * The Gemini CLI adapter: Google's Gemini CLI, driven through its own headless
 * `stream-json` interface (no Node SDK — the JSONL surface IS the programmatic
 * interface). One `gemini -p … -o stream-json` process runs per turn; a stable
 * session id keeps the conversation warm (`--session-id` the first turn,
 * `--resume` after — Gemini's analog of the Codex thread). Events normalize into
 * the shared `WireMsg` union — no protocol change (P.5 spike).
 *
 * Faithful-skin posture (inherit-don't-invent): passes only Mirafold's own
 * concerns — the session cwd and model when set. Auth is API-key (the free
 * Google-login path was deprecated by Google in 2026); the key stays in the
 * server env, injected into the child, never on the wire. Approval for the
 * user's own tools is inherited; only our `genui` MCP server is auto-trusted
 * (the analog of Codex's per-server `approve`), since headless can't prompt.
 */
export class GeminiCliSession implements AgentSession {
  private queue = new AsyncQueue<string | typeof CLOSE>();
  private listeners = new Set<(msg: WireMsg) => void>();
  private closed = false;
  private child?: ChildProcessWithoutNullStreams;
  private sessionId: string;
  private started: boolean; // first turn creates the session, later turns resume
  private resumeIdState: ResumeIdState;
  // RENDER_GUIDANCE rides ahead of the first NON-slash turn (V.2): headless
  // Gemini only recognizes a slash command at position 0 of the prompt, so
  // prepending to a slash turn would silently turn it into chat (observed
  // live 2026-07-19). Tracked apart from `started` for exactly that case.
  private guidanceInjected = false;
  private modelLabel: string | undefined;
  private model?: string;
  private workspaceDir: string;
  private listModels: () => Promise<GeminiModelCatalog>;
  // Non-genui tool ids we announced, and buffered genui render calls awaiting
  // their tool_result (which carries the assigned component id).
  private announced = new Set<string>();
  private pendingRenders = new Map<string, { tool: string; params: Record<string, unknown> }>();
  // The folder-trust ask (P.6b), keyed by wire id → resolver. At most one is
  // ever in flight: it gates the first turn in an untrusted workspace, and a
  // yes is remembered on disk, so later turns never reach it.
  private pendingAsks = new Map<string, (allow: boolean) => void>();
  // Set once the user says yes IN THIS SESSION — the disk record is the
  // durable answer, this just avoids re-reading it every turn.
  private trusted = false;
  // Whether the render-MCP entry has been merged into project settings yet
  // (K.2): deferred until trust is confirmed, unlike the auth stub below.
  private mcpSettingsWritten = false;

  // `modelLabel` is undefined until configured or a turn reports the concrete
  // model — the UI shows nothing, never a stand-in that reads as a model name
  // (2026-07-23, Kyle). "auto" is a genuine configured value (router mode);
  // honestModel() refines it per turn. The fleet uses this label (F.3).
  get modelName(): string | undefined {
    return this.modelLabel;
  }

  get resumeId(): string | undefined {
    return this.resumeIdState.value;
  }

  onResumeId(cb: (id: string) => void) {
    this.resumeIdState.onChange(cb);
  }

  constructor(opts: {
    workspaceDir: string;
    model?: string;
    resumeId?: string;
    listModels?: () => Promise<GeminiModelCatalog>;
  }) {
    this.workspaceDir = path.resolve(opts.workspaceDir);
    mkdirSync(this.workspaceDir, { recursive: true });
    this.model = opts.model;
    this.modelLabel = opts.model;
    this.sessionId = opts.resumeId ?? randomUUID();
    this.started = Boolean(opts.resumeId);
    this.resumeIdState = new ResumeIdState(opts.resumeId || undefined);
    this.listModels = opts.listModels ?? (() => listGeminiModels(this.workspaceDir));
    // Only ever creates a settings.json that didn't already exist (K.2,
    // 2026-08-06): a file that predates this session is the user's, and
    // consent to modify it — same as the MCP entry below — doesn't exist
    // yet at construction time. No read, no parse, no backup, no rewrite of
    // anything pre-existing until ensureTrusted() actually resolves true.
    this.writeAuthSettingsIfAbsent();
    void this.worker();
  }

  refreshPromptOptions() {
    // ACP commands belong to ACP's prompt/command execution surface. This
    // adapter drives stream-json, where sending those strings makes the model
    // answer them as prose. `/model` is the one terminal command Mirafold
    // faithfully implements on this surface with its own provider-backed
    // picker, so it is the only command the shell advertises.
    const options: PromptOption[] = [
      {
        trigger: "/",
        value: "/model",
        label: "model",
        description: "choose what model to use",
        kind: "command",
      },
    ];
    emitPromptOptions((msg) => this.emit(msg), options);
  }

  private settingsFile(): string {
    return path.join(this.workspaceDir, ".gemini", "settings.json");
  }

  // Only called once consent exists (writeMcpSettings, post-trust): existing
  // content is preserved and merged over; an unparseable file is rewritten
  // rather than failing the session, but it's the user's file, so their
  // bytes land in a backup first.
  private readSettings(): Record<string, any> {
    const file = this.settingsFile();
    if (!existsSync(file)) return {};
    const raw = readFileSync(file, "utf8");
    try {
      return JSON.parse(raw);
    } catch {
      const backup = `${file}.mirafold-backup`;
      writeFileSync(backup, raw);
      createLogger("gemini-cli").warn(
        `existing ${file} is not valid JSON — rewriting it (original saved to ${backup})`,
      );
      return {};
    }
  }

  private writeSettings(cfg: Record<string, any>) {
    mkdirSync(path.dirname(this.settingsFile()), { recursive: true });
    writeFileSync(this.settingsFile(), JSON.stringify(cfg, null, 2));
  }

  // Runs at construction, before any trust decision. Declares which auth type
  // to use — but ONLY by creating a brand-new file: that's Mirafold's own
  // bookkeeping, nothing pre-existing touched. A file that's already there,
  // valid or not, is left completely alone until writeMcpSettings runs.
  private writeAuthSettingsIfAbsent() {
    if (existsSync(this.settingsFile())) return;
    this.writeSettings({ security: { auth: { selectedType: "gemini-api-key" } } });
  }

  // Runs only once ensureTrusted() has actually resolved true: the one place
  // allowed to open a pre-existing file, because consent now actually exists.
  // Sets the auth stub too (not just the MCP entry) — a file that predated
  // this session and was left untouched at construction may not have it yet.
  private writeMcpSettings() {
    const cfg = this.readSettings();
    cfg.security = { ...cfg.security, auth: { ...cfg.security?.auth, selectedType: "gemini-api-key" } };
    cfg.mcpServers = {
      ...cfg.mcpServers,
      [MIRAFOLD_MCP]: { command: RENDER_MCP.command, args: RENDER_MCP.args, trust: true },
    };
    this.writeSettings(cfg);
  }

  pushPrompt(text: string) {
    if (!this.closed) this.queue.push(text);
  }

  onMessage(cb: (msg: WireMsg) => void) {
    this.listeners.add(cb);
  }

  interrupt() {
    this.child?.kill("SIGTERM"); // ends the in-flight turn; session stays warm
    this.denyAllPending(); // an unanswered trust ask would pin the turn open
  }

  /** Deny every in-flight ask — the interrupt/close teardown. */
  private denyAllPending() {
    for (const finish of [...this.pendingAsks.values()]) finish(false);
  }

  // Headless Gemini has no interactive-approval channel for its OWN tool calls
  // (like Codex exec). The one thing it does ask is folder trust (P.6b), and
  // that ask is shell-owned — the browser's answer lands here.
  resolvePermission(id: string, allow: boolean) {
    this.pendingAsks.get(id)?.(allow);
  }

  /**
   * Gemini 0.53.0 will not run headless in a folder it doesn't trust: a
   * project can carry its own `.gemini/settings.json` defining MCP servers,
   * i.e. programs. Their own terminal asks once and remembers; so do we,
   * through the shell's permission strip, and the answer persists in
   * Mirafold's state (never blanket-trusting whatever folder is open).
   * Resolves to whether this turn may run.
   */
  private ensureTrusted(): Promise<boolean> {
    if (this.trusted || isWorkspaceTrusted(this.workspaceDir)) {
      this.trusted = true;
      return Promise.resolve(true);
    }
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = randomUUID();
      const finish = (allow: boolean) => {
        clearTimeout(timer);
        this.pendingAsks.delete(id);
        // Announced on EVERY resolution path (answer, timeout, teardown), so
        // other viewports drop their bar instead of holding a stale ask —
        // protocol.ts's rule for permission_request.
        this.emit({ type: "permission_resolved", id, allow });
        if (allow) {
          this.trusted = true;
          trustWorkspace(this.workspaceDir); // remembered: asked once, ever
        }
        resolve(allow);
      };
      const timer = setTimeout(() => finish(false), TRUST_PROMPT_TIMEOUT_MS);
      this.pendingAsks.set(id, finish);
      this.emit({
        type: "permission_request",
        tool: "Gemini",
        detail: `trust this folder — ${this.workspaceDir}`,
        id,
      });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.child?.kill("SIGTERM");
    this.denyAllPending();
    this.queue.push(CLOSE);
  }

  private emit(msg: WireMsg) {
    for (const cb of this.listeners) cb(msg);
  }

  /** Serial turn loop. `/model` is handled here, between turns, so a switch
   *  queued behind a running turn applies in order like any other input. */
  private async worker() {
    while (!this.closed) {
      const item = await this.queue.next();
      if (item === CLOSE) return;
      try {
        const trimmed = item.trim();
        if (trimmed === "/model" || trimmed.startsWith("/model ")) {
          await this.runModelCommand(trimmed.slice("/model".length).trim());
        } else {
          await this.runTurn(item);
        }
      } catch (err) {
        if (this.closed) return;
        // The worker is launched fire-and-forget from the constructor. A
        // preparation failure (most notably an unwritable project settings
        // file) must terminate THIS turn, not escape as an unhandled rejection
        // into index.ts's process-wide last-gasp handler.
        this.emit({ type: "error", message: `Gemini could not start this turn: ${errText(err)}` });
        this.emit({ type: "turn_end" });
      }
    }
  }

  /**
   * V.2 /model parity, Gemini half. Terminal Gemini's /model opens a picker
   * dialog — TUI chrome headless can't reach (a headless bare /model is a
   * fatal "dialog not supported" exit that surfaces here as a silent empty
   * turn; observed live 2026-07-19). So the shell re-skins it: the LIST is
   * Gemini's own catalog (gemini-model-list.ts — the same access-gated rows
   * the terminal dialog builds), rendered as a `question` component whose
   * click sends `/model set <id>` back through this same path — Gemini's own
   * switch syntax. A switch changes the `-m` the next spawn passes; the
   * resumed session keeps its history, exactly what the terminal dialog does.
   *
   * Terminal fidelity on the verbs: `/model set <name> [--persist]` switches,
   * anything else (`/model`, `/model manage`, stray args — the terminal
   * ignores args and opens the dialog) shows the picker.
   */
  private async runModelCommand(arg: string) {
    this.emit({ type: "status", state: "thinking" });
    try {
      if (arg !== "set" && !arg.startsWith("set ")) {
        let catalog: GeminiModelCatalog;
        try {
          catalog = await this.listModels();
        } catch (err) {
          this.emit({
            type: "error",
            message: `Could not read the model list from gemini: ${errText(err)}`,
          });
          return;
        }
        // `this.model` is configured truth once the user has switched; before
        // that the engine's own answer says what a fresh turn would use.
        const currentId = this.model ?? catalog.currentModelId;
        emitModelPicker(
          (msg) => this.emit(msg),
          catalog.models.map((m) => ({ ...m, current: m.id === currentId })),
          {
            clickText: (id) => `/model set ${id}`, // Gemini's own switch syntax
            switchHint: "Send `/model set <model-id>` to switch.",
          },
        );
        return;
      }
      const parts = arg.slice("set".length).trim().split(/\s+/).filter(Boolean);
      // Flag-shaped tokens are never a model name — the same hyphen-leading
      // hardening as the codex adapter, so `-m` can't be handed a flag.
      const name = parts.find((p) => !p.startsWith("-"));
      if (!name) {
        this.emit({ type: "text_delta", text: "Usage: `/model set <model-name> [--persist]`" });
        return;
      }
      this.model = name;
      this.modelLabel = name; // configured-truth immediately; honestModel refines "auto"
      const persistNote = parts.includes("--persist")
        ? " (--persist writes the terminal's own settings file — here the switch lasts this session)"
        : "";
      this.emit({ type: "text_delta", text: `Model set to ${name}.${persistNote}` });
    } finally {
      this.emit({ type: "turn_end" });
    }
  }

  private async runTurn(text: string): Promise<void> {
    // The folder-trust gate runs BEFORE anything is emitted for this turn: an
    // untrusted workspace can't produce a turn at all, and a denied ask must
    // leave the session usable (say why, end the turn) rather than spawn a
    // child that exits 55 with a stderr the user can't act on.
    if (!(await this.ensureTrusted())) {
      this.emit({
        type: "notice",
        text:
          `Gemini won't run in a folder you haven't trusted. Nothing ran. ` +
          `Send another prompt to be asked again, or switch agents.`,
      });
      this.emit({ type: "turn_end" });
      return;
    }
    // The consequential half of settings.json (K.2): only merged in once the
    // trust gate above has actually passed, and only once per session.
    if (!this.mcpSettingsWritten) {
      this.writeMcpSettings();
      this.mcpSettingsWritten = true;
    }
    return this.spawnTurn(text);
  }

  private spawnTurn(text: string): Promise<void> {
    return new Promise((resolve) => {
      // V.2: the headless stream-json surface has no system-prompt/instructions
      // hook (unlike Claude's `systemPrompt.append`), so RENDER_GUIDANCE rides
      // ahead of the first turn instead — the only injection point this engine
      // has. Slash-leading turns are skipped: headless Gemini only recognizes
      // a slash command at position 0, so the prepend would demote the user's
      // command to chat; the guidance waits for the first prose turn.
      const inject = !this.guidanceInjected && !text.trimStart().startsWith("/");
      // Optimistic — REVERTED below if the child dies without ever reading
      // the prompt (no stdout event: the exit-42 id-mode collision, a spawn
      // failure, bad auth). Leaving it consumed there ran every later turn
      // bare, so the model never saw the render tools for the session's
      // whole life (2026-07-29 bughunt).
      if (inject) this.guidanceInjected = true;
      const prompt = inject ? `${RENDER_GUIDANCE}\n\n---\n\n${text}` : text;
      const args = ["-p", prompt, "-o", "stream-json", "--allowed-mcp-server-names", MIRAFOLD_MCP];
      if (this.model) args.push("-m", this.model);
      // `resumed` is THIS turn's mode; `started` is optimistic (set before the
      // child confirms anything) and self-corrected on close below.
      const resumed = this.started;
      args.push(resumed ? "--resume" : "--session-id", this.sessionId);
      this.started = true;
      this.emit({ type: "status", state: "thinking" });

      const child = spawn(geminiBin(), args, {
        cwd: this.workspaceDir,
        env: {
          ...process.env, // GEMINI_API_KEY lives here; never serialized to the wire
          // Only reached once ensureTrusted() holds the user's yes. This is
          // ALSO what makes auth work, which is not obvious: 0.53.0 does not
          // load a project's `.gemini/settings.json` for an UNTRUSTED folder,
          // so the `selectedType: "gemini-api-key"` we write there was being
          // ignored and the CLI fell back to the user-scope selection — an
          // `oauth-personal` login dies on IneligibleTierError (the free-tier
          // client Google retired) while a perfectly good API key sits unused.
          // One cause, two symptoms.
          //
          // `--skip-trust` is NOT equivalent and was measured failing: it lets
          // the run proceed but still doesn't load project settings, so auth
          // falls back and the turn dies. `GEMINI_DEFAULT_AUTH_TYPE` does
          // nothing at all on 0.53.0 (measured: no project settings + that var
          // + trust still fails). The env var below is the whole fix.
          GEMINI_CLI_TRUST_WORKSPACE: "true",
        },
      });
      this.child = child;

      let buf = "";
      let ended = false;
      // Whether any stdout event parsed this turn, and a capped stderr
      // tail — so a stderr-only non-zero exit (the trust-folder trap: Gemini
      // writes the error to stderr, exits 55, and emits NOTHING on stdout)
      // surfaces as an error instead of a silent "thinking…" then nothing (F.4).
      let sawEvent = false;
      let stderrTail = "";
      const end = () => {
        if (ended) return;
        ended = true;
        this.emit({ type: "turn_end" });
        resolve();
      };
      const consume = (line: string) => {
        const s = line.trim();
        if (!s || s[0] !== "{") return; // skip non-JSON noise (e.g. ripgrep warning)
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(s);
        } catch {
          return;
        }
        sawEvent = true;
        this.handleEvent(ev);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          consume(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      // Usually diagnostics, but sometimes the ONLY signal (F.4). Keep a
      // capped tail for the stderr-only-failure path; MIRAFOLD_DEBUG=1 also
      // streams it live (R.4g).
      child.stderr.on("data", (d: Buffer) => {
        stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_CAP);
        if (verbose) createLogger("gemini-cli").debug(`stderr — ${d}`);
      });
      child.on("close", (code: number | null) => {
        if (buf) consume(buf);
        if (this.child === child) this.child = undefined;
        // A non-zero exit that produced no stdout events, with something
        // on stderr, is a silent failure — surface it (code null = a signal
        // kill/interrupt, not this case) (F.4).
        if (!this.closed && !sawEvent && code != null && code !== 0 && stderrTail.trim()) {
          this.emit({ type: "error", message: `gemini exited ${code}: ${stderrTail.trim()}` });
        }
        // Self-heal a wrong id mode (2026-07-23). Gemini treats both id-mode
        // mistakes as FATAL_INPUT_ERROR (42) and exits before emitting any
        // event: `--resume` with an id it never persisted (a first turn that
        // failed before the session file was written — bad auth, missing
        // binary, an early kill), and `--session-id` with an id that already
        // exists. Without this flip the mistake repeats every turn and the
        // session is dead forever; with it the next turn runs the other mode,
        // which the failure itself just proved is the right one ("not found"
        // ⇒ create, "already exists" ⇒ resume).
        if (!this.closed && !sawEvent && code === GEMINI_FATAL_INPUT_ERROR) {
          this.started = !resumed;
        }
        // No stdout event ⇒ the prompt was never read — give the guidance
        // back to the next prose turn (see the inject note above).
        if (!sawEvent && inject) this.guidanceInjected = false;
        end(); // covers the case where no `result` event arrived (crash/kill)
      });
      child.on("error", (err) => {
        if (!this.closed) this.emit({ type: "error", message: `gemini spawn failed: ${err.message}` });
        if (inject) this.guidanceInjected = false; // spawn failed — nothing was read
        end();
      });
    });
  }

  // init.model can be the literal "auto" (router mode) while the real
  // model(s) the router actually used show up only in result.stats.models.
  // Prefer those concrete names when the init label is a placeholder — the
  // status bar should name what ran, like the terminal's own status line (F.3).
  private honestModel(models: unknown): string | undefined {
    const vague = !this.modelLabel || this.modelLabel === "auto";
    if (!vague) return this.modelLabel;
    const names = Array.isArray(models)
      ? models.filter((m): m is string => typeof m === "string")
      : models && typeof models === "object"
        ? Object.keys(models as Record<string, unknown>)
        : [];
    return names.length ? names.join(", ") : this.modelLabel;
  }

  /** Normalize one JSONL event into WireMsg. */
  private handleEvent(ev: Record<string, unknown>) {
    // A session-bearing event proves the CLI accepted/created this id. An
    // error event alone does not: persisting after bad auth/input could make a
    // daemon restart try `--resume` against an id Gemini never wrote.
    const eventType = ev["type"];
    if (
      !this.resumeId &&
      (eventType === "init" ||
        eventType === "message" ||
        eventType === "tool_use" ||
        eventType === "tool_result" ||
        eventType === "result")
    ) {
      this.resumeIdState.publish(this.sessionId);
    }
    switch (eventType) {
      case "init":
        if (typeof ev["model"] === "string") this.modelLabel = ev["model"] as string;
        break;
      case "message": {
        // Assistant chunks are the reply; the user echo is our own prompt.
        if (ev["role"] === "assistant" && typeof ev["content"] === "string") {
          this.emit({ type: "text_delta", text: ev["content"] as string });
        }
        break;
      }
      case "tool_use": {
        const name = String(ev["tool_name"] ?? "");
        const id = String(ev["tool_id"] ?? randomUUID());
        const params = (ev["parameters"] ?? {}) as Record<string, unknown>;
        if (name.startsWith(MCP_PREFIX)) {
          // Our generative-UI tools: buffer until the result carries the id.
          this.pendingRenders.set(id, { tool: name.slice(MCP_PREFIX.length), params });
        } else {
          this.announced.add(id);
          this.emit({
            type: "tool_use",
            name,
            detail: toolDetail(params),
            id,
            input: params,
          });
        }
        break;
      }
      case "tool_result": {
        const id = String(ev["tool_id"] ?? "");
        const pending = this.pendingRenders.get(id);
        if (pending) {
          this.pendingRenders.delete(id);
          if (ev["status"] !== "error") this.emitGenerativeUI(pending, ev["output"]);
          break;
        }
        if (!this.announced.delete(id)) break;
        const capped = capOutput(String(ev["output"] ?? ""));
        this.emit({
          type: "tool_result",
          output: capped.text,
          truncatedBytes: capped.truncatedBytes,
          isError: ev["status"] === "error",
          id,
        });
        break;
      }
      case "error":
        if (typeof ev["message"] === "string") this.emit({ type: "error", message: ev["message"] as string });
        break;
      case "result": {
        const stats = (ev["stats"] ?? {}) as Record<string, unknown>;
        const model = this.honestModel(stats["models"]);
        // The refinement must land on modelLabel too — modelName is what the
        // fleet and status bar read (F.3), and it stayed "auto" forever while
        // only the usage line got the concrete names (2026-07-28 fix). Router
        // mode re-vagues at the next turn's init, so each turn re-refines.
        if (model) this.modelLabel = model;
        this.emit({
          type: "usage",
          model,
          inputTokens: Number(stats["input_tokens"] ?? 0),
          outputTokens: Number(stats["output_tokens"] ?? 0),
        });
        break;
      }
    }
  }

  /** A buffered genui tool call → the render/artifact WireMsg it stands for. */
  private emitGenerativeUI(pending: { tool: string; params: Record<string, unknown> }, output: unknown) {
    const id = typeof pending.params["id"] === "string" ? (pending.params["id"] as string) : parseRenderId(output);
    const msg = generativeUIMsg(pending.tool, pending.params, id, this.workspaceDir);
    if (msg) this.emit(msg);
  }
}
