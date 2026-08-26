import path from "node:path";
import { createLogger, verbose } from "../log";
import { closeSync, constants, mkdirSync, openSync, readFileSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { PromptOption, SessionMsg } from "../protocol";
import { RENDER_GUIDANCE } from "../render-tools";
import { type AgentSession, capOutput, emitPromptOptions, envWithout, errText, toolDetail } from "./types";
import { MIRAFOLD_MCP, generativeUIMsg, renderIdFor, renderMcpCommand } from "./render-mcp-cmd";
import { PermissionLedger, RenderGuidanceOnce, runSlashTurn } from "./wire-helpers";
import { geminiBin, listGeminiModels, type GeminiModelCatalog } from "./gemini-model-list";
import { emitModelPicker } from "./model-picker";
import { isWorkspaceTrusted, trustWorkspace } from "../sessions/workspace-trust";
import { AsyncQueue, CLOSE } from "./async-queue";
import { ResumeIdState } from "./resume-id";

// Same generative-UI stdio MCP server the Codex adapter injects. Gemini
// loads MCP servers from settings.json, so we write a per-session project
// `.gemini/settings.json` naming it (merged over the user's global config).
const RENDER_MCP = renderMcpCommand();
// Gemini names MCP tools `mcp_<server>_<tool>`; ours therefore start with this.
const MCP_PREFIX = `mcp_${MIRAFOLD_MCP}_`;
// How much of a failed turn's stderr rides into the surfaced error.
const STDERR_TAIL_CAP = 4000;
// How long the folder-trust ask waits for an answer before denying —
// the same posture as Claude's permission prompt: an unanswered ask must not
// pin a turn open forever.
const TRUST_PROMPT_TIMEOUT_MS = 5 * 60_000;
// Gemini CLI's ExitCodes.FATAL_INPUT_ERROR — the exit for an unusable
// `--resume`/`--session-id` id, thrown in resolveSessionId() before any
// stdout event (verified against v0.51.0).
const GEMINI_FATAL_INPUT_ERROR = 42;

/** The component id the render-mcp stub returned, parsed from its output text. */
export function parseRenderId(output: unknown): string {
  return renderIdFor({ ackText: output });
}

/**
 * The Gemini CLI adapter: Google's Gemini CLI, driven through its own headless
 * `stream-json` interface (no Node SDK — the JSONL surface IS the programmatic
 * interface). One `gemini -p … -o stream-json` process runs per turn; a stable
 * session id keeps the conversation warm (`--session-id` the first turn,
 * `--resume` after — Gemini's analog of the Codex thread). Events normalize into
 * the shared `WireMsg` union — no protocol change.
 *
 * Faithful-skin posture (inherit-don't-invent): passes only Mirafold's own
 * concerns — the session cwd and model when set. Auth is API-key (the free
 * Google-login path stopped serving individual accounts in 2026); the key stays in the
 * server env, injected into the child, never on the wire. Approval for the
 * user's own tools is inherited; only our `mirafold` MCP server is auto-trusted
 * (the analog of Codex's per-server `approve`), since headless can't prompt.
 */
export class GeminiCliSession implements AgentSession {
  private queue = new AsyncQueue<string | typeof CLOSE>();
  private listeners = new Set<(msg: SessionMsg) => void>();
  private closed = false;
  private child?: ChildProcessWithoutNullStreams;
  private sessionId: string;
  private started: boolean; // first turn creates the session, later turns resume
  private resumeIdState: ResumeIdState;
  // RENDER_GUIDANCE rides ahead of the first NON-slash turn: headless
  // Gemini only recognizes a slash command at position 0 of the prompt, so
  // prepending to a slash turn would silently turn it into chat; the
  // guidance waits for the first prose turn.
  private guidance = new RenderGuidanceOnce(RENDER_GUIDANCE);
  private modelLabel: string | undefined;
  private model?: string;
  private workspaceDir: string;
  private listModels: () => Promise<GeminiModelCatalog>;
  // Non-render tool ids we announced, and buffered Mirafold render calls awaiting
  // their tool_result (which carries the assigned component id).
  private announced = new Set<string>();
  private pendingRenders = new Map<string, { tool: string; params: Record<string, unknown> }>();
  // The folder-trust ask, keyed by wire id → resolver. At most one is
  // ever in flight: it gates the first turn in an untrusted workspace, and a
  // yes is remembered on disk, so later turns never reach it.
  private permissions = new PermissionLedger((msg) => this.emit(msg));
  // Set once the user says yes IN THIS SESSION — the disk record is the
  // durable answer, this just avoids re-reading it every turn.
  private trusted = false;
  // Whether the render-MCP entry and auth selection have been merged into
  // project settings yet: both are deferred until Gemini-specific trust is
  // confirmed.
  private mcpSettingsWritten = false;

  // `modelLabel` is undefined until configured or a turn reports the concrete
  // model — the UI shows nothing, never a stand-in that reads as a model name.
  // "auto" is a genuine configured value (router mode); honestModel()
  // refines it per turn. The fleet uses this label.
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

  /**
   * Every file this adapter writes in the project is opened with O_NOFOLLOW
   * (and the backup exclusively): the consented write is to THIS folder's
   * own files, and a repository must not get to choose where a write lands.
   * A checkout can ship `.gemini/settings.json` — or the backup's name
   * beside it — as a symlink (dangling ones pass `existsSync`) pointing at
   * `~/.ssh/authorized_keys` or any user-owned path; a path check alone
   * missed the backup write on the first cut (cold review, 2026-08-26), so
   * the rule lives at open time, for every write, not in a list of paths.
   * A hardlink — which git cannot deliver — is the accepted residual, as
   * for the daemon's `.env` guard.
   */
  private writeOwnFile(file: string, data: string, exclusive = false) {
    const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL, O_NOFOLLOW } = constants;
    const flags = O_WRONLY | O_CREAT | (O_NOFOLLOW ?? 0) | (exclusive ? O_EXCL : O_TRUNC);
    let fd: number;
    try {
      fd = openSync(file, flags, 0o644);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") {
        throw new Error(
          `${file} is a symlink — Mirafold only writes this folder's own .gemini files; ` +
            `replace it with a real file or remove it`,
        );
      }
      throw err;
    }
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The directory half of the same rule: O_NOFOLLOW guards only the last
   * path component, so `.gemini` itself being a symlink (to `~/.gemini`, or
   * anywhere) is refused here, and a FIFO/device at `settings.json` is
   * refused before a read could block the daemon. The turn fails with a
   * sentence the user can act on; nothing is written (audit 2026-08-26).
   */
  private assertSettingsPathIsOurs() {
    const file = this.settingsFile();
    const check = (p: string, want: "directory" | "file") => {
      let st;
      try {
        st = lstatSync(p);
      } catch {
        return; // absent: we would create it, which is fine
      }
      const ok = want === "directory" ? st.isDirectory() : st.isFile();
      if (!ok) {
        throw new Error(
          `${p} is ${st.isSymbolicLink() ? "a symlink" : `not a ${want}`} — Mirafold only writes ` +
            `this folder's own .gemini/settings.json; replace it with a real ${want} or remove it`,
        );
      }
    };
    check(path.dirname(file), "directory");
    check(file, "file");
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
      // Exclusive create: never through a link a checkout planted under the
      // backup's name, never over an earlier backup — a taken name gets a
      // timestamped sibling instead.
      let backup = `${file}.mirafold-backup`;
      try {
        this.writeOwnFile(backup, raw, true);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        backup = `${file}.mirafold-backup.${Date.now()}`;
        this.writeOwnFile(backup, raw, true);
      }
      createLogger("gemini-cli").warn(
        `existing ${file} is not valid JSON — rewriting it (original saved to ${backup})`,
      );
      return {};
    }
  }

  private writeSettings(cfg: Record<string, any>) {
    mkdirSync(path.dirname(this.settingsFile()), { recursive: true });
    this.writeOwnFile(this.settingsFile(), JSON.stringify(cfg, null, 2));
  }

  // Runs only once ensureTrusted() has actually resolved true: the one place
  // allowed to open a pre-existing file, because consent now actually exists.
  // Sets the auth stub too (not just the MCP entry) — a file that predated
  // this session and was left untouched at construction may not have it yet.
  private writeMcpSettings() {
    this.assertSettingsPathIsOurs();
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

  onMessage(cb: (msg: SessionMsg) => void) {
    this.listeners.add(cb);
  }

  interrupt() {
    this.child?.kill("SIGTERM"); // ends the in-flight turn; session stays warm
    this.permissions.denyAll(); // an unanswered trust ask would pin the turn open
  }

  // Headless Gemini has no interactive-approval channel for its OWN tool calls
  // (like Codex exec). The one thing it does ask is folder trust, and
  // that ask is shell-owned — the browser's answer lands here.
  resolvePermission(id: string, allow: boolean) {
    this.permissions.resolve(id, allow);
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
    if (this.trusted || isWorkspaceTrusted(this.workspaceDir, "gemini-cli")) {
      this.trusted = true;
      return Promise.resolve(true);
    }
    if (this.closed) return Promise.resolve(false);
    // The ask says what a yes DOES, not just what it's called: besides
    // letting Gemini run here, it merges Mirafold's render-tool MCP entry and
    // the API-key auth selection into this folder's `.gemini/settings.json`
    // — a file terminal Gemini reads too. A user answering "trust" deserves
    // to know that a project file changes as a result.
    return this.permissions.ask(
      {
        tool: "Gemini",
        detail:
          `trust this folder — ${this.workspaceDir}. ` +
          `Yes lets Gemini run here, adds Mirafold's render tools to this folder's ` +
          `.gemini/settings.json, and sets its auth type to API key (replacing any other choice). ` +
          `Other settings are merged; if that file is not valid JSON, its original bytes are saved ` +
          `beside it before Mirafold replaces it. Terminal Gemini reads this file too.`,
      },
      TRUST_PROMPT_TIMEOUT_MS,
      (allow) => {
        if (allow) {
          this.trusted = true;
          trustWorkspace(this.workspaceDir, "gemini-cli"); // remembered for this disclosed effect
        }
      },
    );
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.child?.kill("SIGTERM");
    this.permissions.denyAll();
    this.queue.push(CLOSE);
  }

  private emit(msg: SessionMsg) {
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
          // The catalog is read by spawning Gemini IN this folder
          // (gemini-model-list.ts), so it sits behind the same trust gate as
          // a turn: only Gemini's own untrusted-folder rule stood between a
          // checkout's `.gemini/settings.json` and that spawn (2026-08-26).
          if (!(await this.ensureTrusted())) this.refuseUntrusted();
          else await this.runModelCommand(trimmed.slice("/model".length).trim());
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
   * Terminal Gemini's /model opens a picker dialog — TUI chrome headless
   * can't reach (a headless bare /model is a fatal "dialog not supported"
   * exit that surfaces here as a silent empty turn). So the shell re-skins
   * it: the LIST is Gemini's own catalog (gemini-model-list.ts — the same
   * access-gated rows the terminal dialog builds), shown as the shell-owned
   * `picker` message (model-picker.ts) whose chosen row sends
   * `/model set <id>` back through this same path — Gemini's own switch
   * syntax. A switch changes the `-m` the next spawn passes; the
   * resumed session keeps its history, exactly what the terminal dialog does.
   *
   * Terminal fidelity on the verbs: `/model set <name> [--persist]` switches,
   * anything else (`/model`, `/model manage`, stray args — the terminal
   * ignores args and opens the dialog) shows the picker.
   */
  private runModelCommand(arg: string): Promise<void> {
    return runSlashTurn((msg) => this.emit(msg), async () => {
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
    });
  }

  private async runTurn(text: string): Promise<void> {
    // The folder-trust gate runs BEFORE anything is emitted for this turn: an
    // untrusted workspace can't produce a turn at all, and a denied ask must
    // leave the session usable (say why, end the turn) rather than spawn a
    // child that exits 55 with a stderr the user can't act on.
    if (!(await this.ensureTrusted())) {
      this.refuseUntrusted();
      return;
    }
    // The consequential half of settings.json: only merged in once the
    // trust gate above has actually passed, and only once per session.
    if (!this.mcpSettingsWritten) {
      this.writeMcpSettings();
      this.mcpSettingsWritten = true;
    }
    return this.spawnTurn(text);
  }

  /** A denied (or timed-out) trust ask: say why, end the turn, spawn nothing. */
  private refuseUntrusted() {
    this.emit({
      type: "notice",
      text:
        `Gemini won't run in a folder you haven't trusted. Nothing ran. ` +
        `Send another prompt to be asked again, or switch agents.`,
    });
    this.emit({ type: "turn_end" });
  }

  private spawnTurn(text: string): Promise<void> {
    return new Promise((resolve) => {
      // The headless stream-json surface has no system-prompt/instructions
      // hook (unlike Claude's `systemPrompt.append`), so RENDER_GUIDANCE rides
      // ahead of the first turn instead — the only injection point this engine
      // has. Slash-leading turns are skipped: headless Gemini only recognizes
      // a slash command at position 0, so the prepend would demote the user's
      // command to chat; the guidance waits for the first prose turn.
      const inject = this.guidance.pending && !text.trimStart().startsWith("/");
      const prompt = inject ? this.guidance.carry(text) : text;
      // Optimistic — REVERTED below if the child dies without ever reading
      // the prompt (no stdout event: the exit-42 id-mode collision, a spawn
      // failure, bad auth).
      if (inject) this.guidance.delivered();
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
          ...envWithout(), // GEMINI_API_KEY lives here (never the daemon's own secrets); never serialized to the wire
          // Only reached once ensureTrusted() holds the user's yes. This is
          // ALSO what makes auth work, which is not obvious: 0.53.0 does not
          // load a project's `.gemini/settings.json` for an UNTRUSTED folder,
          // so the `selectedType: "gemini-api-key"` we write there is
          // ignored and the CLI falls back to the user-scope selection — an
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
      // surfaces as an error instead of a silent "thinking…" then nothing.
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
      // Usually diagnostics, but sometimes the ONLY signal. Keep a
      // capped tail for the stderr-only-failure path; MIRAFOLD_DEBUG=1 also
      // streams it live.
      child.stderr.on("data", (d: Buffer) => {
        stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_CAP);
        if (verbose) createLogger("gemini-cli").debug(`stderr — ${d}`);
      });
      child.on("close", (code: number | null) => {
        if (buf) consume(buf);
        if (this.child === child) this.child = undefined;
        // A non-zero exit that produced no stdout events, with something
        // on stderr, is a silent failure — surface it (code null = a signal
        // kill/interrupt, not this case).
        if (!this.closed && !sawEvent && code != null && code !== 0 && stderrTail.trim()) {
          this.emit({ type: "error", message: `gemini exited ${code}: ${stderrTail.trim()}` });
        }
        // Self-heal a wrong id mode. Gemini treats both id-mode
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
        if (!sawEvent && inject) this.guidance.reset();
        end(); // covers the case where no `result` event arrived (crash/kill)
      });
      child.on("error", (err) => {
        if (!this.closed) this.emit({ type: "error", message: `gemini spawn failed: ${err.message}` });
        if (inject) this.guidance.reset(); // spawn failed — nothing was read
        end();
      });
    });
  }

  // init.model can be the literal "auto" (router mode) while the real
  // model(s) the router actually used show up only in result.stats.models.
  // Prefer those concrete names when the init label is a placeholder — the
  // status bar should name what ran, like the terminal's own status line.
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

  /** Normalize one JSONL event into SessionMsg. */
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
        const id = String(ev["tool_id"] ?? "") || randomUUID();
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
        // fleet and status bar read; otherwise it stays "auto" forever while
        // only the usage line gets the concrete names. Router mode re-vagues
        // at the next turn's init, so each turn re-refines.
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

  /** A buffered Mirafold render tool call → the render/artifact SessionMsg it stands for. */
  private emitGenerativeUI(pending: { tool: string; params: Record<string, unknown> }, output: unknown) {
    const id = renderIdFor({ ackText: output, argId: pending.params["id"] });
    const msg = generativeUIMsg(pending.tool, pending.params, id, this.workspaceDir);
    if (msg) this.emit(msg);
  }
}
