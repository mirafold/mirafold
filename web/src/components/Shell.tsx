import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, AgentName } from "@protocol";
import { Onboarding } from "./Onboarding";
import { PromptBox } from "./PromptBox";
import { RenderZone } from "./RenderZone";
import { FilesPanel } from "./files/FilesPanel";
import { StatusBar, FilesGlyph, type Usage } from "./StatusBar";
import { createSessionBus } from "../session-bus";
import {
  MODE_STORAGE_KEY,
  THEMES,
  resolveSlot,
  slotStorageKey,
  type ThemeAppearance,
} from "../themes/manifest";
import { ThemePicker } from "./ThemePicker";
import { tildify } from "../tildify";
import { agentLabel, connectHint } from "../agents-meta";
import { paintTabStatus } from "../tab-status";
import { useEscapeKey } from "../use-escape";
import { Announcer, turnResponse, useAnnouncer } from "./Announcer";

// The zone-message type lives with the bus (H.9); re-exported so consumers
// of the shell's contract (RenderZone) keep their import site.
export type { ZoneMsg } from "../session-bus";

const ZERO_USAGE: Usage = { turnIn: 0, turnOut: 0, sumIn: 0, sumOut: 0, cost: 0 };

/**
 * The trusted shell. Owns the socket and the prompt box; neither is ever
 * re-rendered or touched by agent output. The agent only paints into
 * RenderZone via the message bus below.
 *
 * A connection is a viewport onto a registry session. The URL is
 * the session identity (/s/<id>) — refresh-safe and shareable across tabs (4.2).
 */
export function Shell() {
  // ── The turn ──────────────────────────────────────────────────────────
  // Whether a turn is in flight — drives the stop affordance and Esc.
  // Derived entirely from the wire: user_prompt sets it, turn_end clears it,
  // and a replayed in-flight turn therefore restores it correctly.
  const [busy, setBusy] = useState(false);
  // Pending permission prompts, oldest first; the bar shows one at a time.
  // SHELL-OWNED UI: the agent can paint nothing here, so it can't fake it.
  const [asks, setAsks] = useState<{ tool: string; detail: string; id: string }[]>([]);

  // ── The session + daemon (status-bar state, T2.6 — all shell-owned) ─────
  const [connected, setConnected] = useState(false);
  // A relay refusal reason while disconnected (R.4: no daemon / at capacity /
  // origin), surfaced in the status indicator; undefined = an ordinary drop.
  const [connNote, setConnNote] = useState<string | undefined>(undefined);
  const [meta, setMeta] = useState<{
    sessionId?: string;
    cwd?: string;
    agent?: AgentName;
    model?: string;
    demo?: boolean;
  }>({});
  const [usage, setUsage] = useState<Usage>(ZERO_USAGE);
  // Everything the daemon's `agents` hello carries, kept together: which
  // agents it offers (P.4 onboarding; a URL that already names a session
  // skips the picker), where it was launched (4.8 — the default session cwd)
  // + home for ~-abbreviation, the pairing info for the "connect a device"
  // QR (R.4, local viewports only), and its build version.
  const [daemonInfo, setDaemonInfo] = useState<{
    agents: AgentInfo[] | null;
    cwd?: string;
    home?: string;
    relay?: { url: string; code: string; ws?: string };
    version?: string;
  }>({ agents: null });

  // ── The dismissable notices (all SHELL-OWNED — the agent paints none) ───
  const [notices, setNotices] = useState<{
    // The server took the attach-fallback branch — the session this tab
    // asked for is gone (daemon restart, expiry) and this is a FRESH one. A
    // silent URL swap over a blank transcript reads as data loss with no
    // explanation; this shell-drawn notice says what happened. Cleared on
    // dismiss or on the first prompt into the new session (R.4c).
    session: boolean;
    // The daemon refused this REMOTE viewport because the session runs
    // on a subscription login, which can't be driven over the paid relay.
    // Shown until dismissed (R.4i).
    refused: string | null;
    // The last create error, so the onboarding card can show a rejected
    // working dir (4.8).
    onboarding: string | null;
  }>({ session: false, refused: null, onboarding: null });

  // ── The `!` command (4.9) ───────────────────────────────────────────────
  const [bang, setBang] = useState<{
    // The bang THIS viewport issued, if still running — only the issuer gets
    // the stdin affordance (a sudo prompt must never fan out to a second tab
    // or, later, a phone via the relay). Lost on refresh: Tier 1.
    my: { id: string; command: string } | null;
    // Tail of the running command's output — drives the password-prompt
    // detection that masks the stdin field. One bang per session, so untagged.
    tail: string;
  }>({ my: null, tail: "" });

  const hasUrlSession = useMemo(() => /^\/s\/[\w-]+/.test(location.pathname), []);

  // ── The Explorer (Phase E) ──────────────────────────────────────────────
  // The read-only files panel, collapsed by default (nothing changes for a
  // user who never opens it). Shell-owned; the agent paints nothing in it.
  const [filesOpen, setFilesOpen] = useState(false);

  // ── The theme (4.3; two-slot model S.3) ─────────────────────────────────
  // Theme is shell-owned UI state. Dark is the default and the identity;
  // index.html applies the stored choice before first paint (no flash) and
  // this keeps the attribute + storage in sync on toggle. The mode is which
  // side of the pill is active; each side resolves to a theme id through
  // its settings slot (defaults: the built-in pair, which makes this
  // byte-identical to the pre-slot behavior). The pill itself is LOCKED
  // unchanged (Phase S charter): two positions, mode in, mode out.
  const [mode, setMode] = useState<ThemeAppearance>(() =>
    localStorage.getItem(MODE_STORAGE_KEY) === "light" ? "light" : "dark",
  );
  const [slots, setSlots] = useState<Record<ThemeAppearance, string>>(() => ({
    light: resolveSlot("light", localStorage.getItem(slotStorageKey("light"))),
    dark: resolveSlot("dark", localStorage.getItem(slotStorageKey("dark"))),
  }));
  useEffect(() => {
    document.documentElement.dataset.theme = slots[mode];
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    localStorage.setItem(slotStorageKey("light"), slots.light);
    localStorage.setItem(slotStorageKey("dark"), slots.dark);
  }, [mode, slots]);
  // Settings card (S.4). Picking a theme fills its appearance side's slot
  // and switches to that side so the pick paints immediately — picking is
  // seeing. Appearance fit is enforced here, the one place slots are written.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pickTheme = (id: string) => {
    const entry = THEMES.find((t) => t.id === id);
    if (!entry) return;
    setSlots((s) => ({ ...s, [entry.appearance]: id }));
    setMode(entry.appearance);
  };

  // The socket + pub/sub live in session-bus.ts (H.9); one bus per mount.
  // useState's lazy initializer, NOT useMemo: Fast Refresh re-runs useMemo on
  // every hot edit (dependency lists are deliberately ignored), and each
  // re-run opened a fresh socket while the orphaned one stayed attached —
  // inflating the fleet's viewport count during dev (2026-07-25, Kyle).
  // State survives a hot update, so the one bus lives as long as the page.
  const [bus] = useState(createSessionBus);

  // Screen-reader announcements (A.1) — see Announcer.tsx for why the
  // transcript itself stays silent and these speak at turn boundaries.
  const { message: announcement, announce } = useAnnouncer();
  // The turn's prose, accumulated from text_delta so turn_end can announce
  // the response once, whole. A ref (not state): nothing renders from it, and
  // it must not re-run the subscription on every token.
  const turnText = useRef("");
  // Only announce connection TRANSITIONS — onConnection fires true on mount,
  // and "Reconnected" on page load is a lie.
  const wasConnected = useRef<boolean | null>(null);

  useEffect(
    () =>
      bus.subscribe((m) => {
        if (m.type === "user_prompt") {
          setBusy(true);
          turnText.current = "";
          announce("Sent. Working…");
          // They've moved on in the new session — the R.4c notice is done.
          setNotices((n) => (n.session ? { ...n, session: false } : n));
        } else if (
          m.type === "status" ||
          m.type === "thinking_delta" ||
          m.type === "text_delta" ||
          m.type === "tool_use"
        ) {
          // Busy re-derives from ANY turn activity, not just the
          // user_prompt — a tail resume mid-turn replays none of the turn's
          // opening frames, and busy was cleared on the disconnect (R.4c).
          setBusy(true);
          // A.1: the response is announced once at turn_end, so the prose is
          // banked here rather than spoken per token.
          if (m.type === "text_delta") turnText.current += m.text;
          // Tool activity is the other thing a sighted user reads off the
          // transcript mid-turn; announce the name, not the arguments.
          if (m.type === "tool_use") announce(`Running ${m.name}.`);
        } else if (m.type === "turn_end") {
          setBusy(false);
          setAsks([]); // a request that outlived its turn is void (server denies)
          announce(turnResponse(turnText.current));
          turnText.current = "";
        } else if (m.type === "permission_request") {
          setAsks((a) => [...a, { tool: m.tool, detail: m.detail, id: m.id }]);
          // Assertive: this one blocks the turn until answered.
          announce(`Permission needed: ${m.tool}. ${m.detail}`, true);
        } else if (m.type === "agents") {
          setDaemonInfo({
            agents: m.agents,
            cwd: m.cwd,
            home: m.home,
            relay: m.relay,
            version: m.version,
          });
        } else if (m.type === "session_created") {
          setMeta({ sessionId: m.sessionId, cwd: m.cwd, agent: m.agent, model: m.model, demo: m.demo });
          setNotices((n) => ({
            ...n,
            onboarding: null,
            ...(m.fallback ? { session: true } : {}),
          }));
        } else if (m.type === "refused") {
          // No session — the relay refused this subscription-backed
          // attach. Show the reason (also surfaced at onboarding if we're there) (R.4i).
          setNotices((n) => ({ ...n, refused: m.message, onboarding: m.message }));
          announce(m.message, true);
        } else if (m.type === "error") {
          // Only the onboarding card consumes this; in-session errors already
          // render in the output zone.
          setNotices((n) => ({ ...n, onboarding: m.message }));
          announce(m.message, true);
        } else if (m.type === "bang_start") {
          setBang((b) => ({ ...b, tail: "" }));
        } else if (m.type === "bang_output") {
          // Only the tail matters (prompt detection) — keep it tiny.
          setBang((b) => ({ ...b, tail: (b.tail + m.data).slice(-400) }));
        } else if (m.type === "bang_end") {
          setBang((b) => (b.my && b.my.id === m.id ? { ...b, my: null } : b));
        } else if (m.type === "usage") {
          // Tokens are per-turn → sum for the session total. Cost is already
          // the session-cumulative figure → take it as-is, never add (T2.6).
          // Reset-on-zone_reset keeps both replay-safe: re-summing tokens and
          // re-taking the final cost both land on the right number.
          setUsage((u) => ({
            model: m.model,
            turnIn: m.inputTokens,
            turnOut: m.outputTokens,
            sumIn: u.sumIn + m.inputTokens,
            sumOut: u.sumOut + m.outputTokens,
            cost: m.costUsd ?? u.cost,
          }));
        } else if (m.type === "zone_reset") {
          setBusy(false);
          setAsks([]);
          setUsage(ZERO_USAGE);
          turnText.current = "";
        }
      }),
    [bus, announce],
  );

  useEffect(
    () =>
      bus.onConnection((c, refusal) => {
        setConnected(c);
        setConnNote(c ? undefined : refusal);
        // A.1: losing the socket is silent on screen except for a dot
        // changing colour — assertive, and only on a real transition.
        if (wasConnected.current !== null && wasConnected.current !== c) {
          if (c) announce("Reconnected.");
          else announce(refusal ?? "Disconnected — reconnecting.", true);
        }
        wasConnected.current = c;
        // A dropped socket can't be mid-turn from this viewport's point
        // of view — clear the working state and the ■ esc stop affordance so
        // a dead daemon doesn't look like an agent still thinking. Replay (or
        // the turn-activity frames above) re-derives busy after reconnect (R.4c).
        if (!c) setBusy(false);
      }),
    [bus, announce],
  );

  // Esc interrupts from anywhere in the page, not just the textarea. Stable
  // identity — a fresh arrow each render would re-register the window
  // listener on every re-render of a streaming turn.
  const interrupt = useCallback(() => bus.interrupt(), [bus]);
  useEscapeKey(busy ? interrupt : undefined);

  // Stable identity: Onboarding keys its poll interval on this prop, so a
  // fresh arrow each render would restart the 3s timer instead of letting
  // it fire.
  const refreshAgents = useCallback(() => bus.refreshAgents(), [bus]);

  // Tab title + favicon status light (Step 4.2) — painter in tab-status.ts.
  useEffect(() => {
    paintTabStatus(asks.length > 0 ? "permission" : busy ? "busy" : "idle");
  }, [busy, asks.length]);

  const answer = (id: string, allow: boolean) => {
    bus.answerPermission(id, allow);
    setAsks((a) => a.filter((x) => x.id !== id));
  };

  // A leading `!` is intercepted by the trusted shell and runs as a real
  // shell command (4.9); the finished transcript then reaches the agent as
  // its own turn, exactly as the terminal harness does.
  const send = (text: string) => {
    const m = text.match(/^!\s*(.+)$/s);
    if (m) {
      const command = m[1].trim();
      setBang({ my: { id: bus.sendBang(command), command }, tail: "" });
    } else {
      bus.sendPrompt(text);
    }
  };

  // Onboarding shows until this viewport has a session — but not when the URL
  // already names one (that path attaches straight through).
  const showOnboarding = !hasUrlSession && !meta.sessionId;

  return (
    <div className="shell">
      <Announcer message={announcement} />
      {showOnboarding && (
        <Onboarding
          agents={daemonInfo.agents}
          defaultCwd={tildify(daemonInfo.cwd, daemonInfo.home)}
          error={notices.onboarding}
          onPick={(agent, cwd, backend) => {
            setNotices((n) => ({ ...n, onboarding: null }));
            bus.createSession(agent, cwd, backend);
          }}
          onRefresh={refreshAgents}
        />
      )}
      <div className="behind-dialog" inert={showOnboarding || undefined}>
        {notices.session && (
          // SHELL-OWNED notice — honest about the swap the server made (R.4c).
          <div className="session-notice">
            <span className="session-notice-text">
              that session ended — started a new one (the daemon restarted or the
              session expired; the previous transcript wasn't saved)
            </span>
            <button
              className="session-notice-dismiss"
              onClick={() => setNotices((n) => ({ ...n, session: false }))}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
        {notices.refused && (
          // SHELL-OWNED — the relay refused a subscription-backed session (R.4i).
          <div className="session-notice">
            <span className="session-notice-text">{notices.refused}</span>
            <button
              className="session-notice-dismiss"
              onClick={() => setNotices((n) => ({ ...n, refused: null }))}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
        {meta.demo && (
          // SHELL-OWNED banner — the agent paints nothing here, so a demo
          // session is unmistakably labeled and the label can't be faked or
          // cleared (same trust rule as the permission bar) (R.4b).
          <div className="demo-banner">
            <span className="demo-banner-badge">demo</span>
            <span className="demo-banner-text">
              scripted replies — no real agent is running
              {meta.agent && connectHint(meta.agent) && (
                <>
                  {" · to connect "}
                  {agentLabel(meta.agent)}: {connectHint(meta.agent)}, then restart Mirafold
                </>
              )}
            </span>
          </div>
        )}
        {/* The activity bar (VS Code convention) is the workbench's permanent
            left edge — it spans transcript, prompt box AND status bar,
            everything to its strict right; only banners run full-width. Its
            files icon opens/collapses the Explorer panel (E.3), which sits
            left of the transcript in a flex row so the transcript keeps
            rendering beside it; panel closed = transcript full-width. */}
        <div className="main-row">
          <ActivityBar
            filesOpen={filesOpen}
            disabled={!meta.sessionId}
            onToggleFiles={() => setFilesOpen((f) => !f)}
          />
          <div className="main-col">
            <div className="zone-outer">
              <FilesPanel
                open={filesOpen && Boolean(meta.sessionId)}
                subscribe={bus.subscribe}
                requestList={bus.requestFsList}
                requestRead={bus.requestFsRead}
                requestDiff={bus.requestFsDiff}
                onClose={() => setFilesOpen(false)}
                rootLabel={tildify(meta.cwd, daemonInfo.home)}
                sessionKey={meta.sessionId}
              />
              <RenderZone subscribe={bus.subscribe} sendAction={bus.sendAction} />
            </div>
            {asks.length > 0 && (
              <div className="perm-bar">
                <span className="perm-badge">permission</span>
                <span className="perm-tool">{asks[0].tool}</span>
                <code className="perm-detail">{asks[0].detail}</code>
                {asks.length > 1 && <span className="perm-more">+{asks.length - 1}</span>}
                <button className="perm-allow" onClick={() => answer(asks[0].id, true)}>
                  allow
                </button>
                <button className="perm-deny" onClick={() => answer(asks[0].id, false)}>
                  deny
                </button>
              </div>
            )}
            {bang.my && (
              <BangBar
                command={bang.my.command}
                tail={bang.tail}
                onInput={(data) => bus.sendBangInput(bang.my!.id, data)}
                onKill={() => bus.killBang(bang.my!.id)}
              />
            )}
            <PromptBox
              onSend={send}
              busy={busy}
              onInterrupt={bus.interrupt}
              cwd={tildify(meta.cwd, daemonInfo.home)}
            />
            <StatusBar
              connected={connected}
              connectionNote={connNote}
              agent={meta.agent}
              // The engine's live report (usage) wins once a turn has run; until
              // then, what the daemon knew at attach ("default" beats nothing).
              model={usage.model ?? meta.model}
              sessionId={meta.sessionId}
              cwd={meta.cwd}
              usage={usage}
              mode={mode}
              onToggleTheme={() => setMode((m) => (m === "dark" ? "light" : "dark"))}
              onOpenSettings={() => setSettingsOpen(true)}
              onEndSession={meta.sessionId ? bus.endSession : undefined}
              relay={daemonInfo.relay}
              version={daemonInfo.version}
              filesOpen={filesOpen}
              filesDisabled={!meta.sessionId}
              onToggleFiles={() => setFilesOpen((f) => !f)}
            />
          </div>
        </div>
        {settingsOpen && (
          <ThemePicker
            slots={slots}
            onPick={pickTheme}
            onClose={() => setSettingsOpen(false)}
            // The card's Session section (R.4l) — on phone this is THE place
            // these facts live (the bar carries only the agent name; the
            // prompt crumb is desktop-only), so it gets everything.
            session={{
              agent: meta.agent,
              model: usage.model ?? meta.model,
              cwd: tildify(meta.cwd, daemonInfo.home),
              sessionId: meta.sessionId,
              version: daemonInfo.version,
              usage:
                usage.sumIn + usage.sumOut > 0
                  ? { sum: usage.sumIn + usage.sumOut, cost: usage.cost }
                  : undefined,
            }}
          />
        )}
      </div>
    </div>
  );
}

/** The workbench's permanent left strip (VS Code's activity-bar convention):
 *  always present so the affordance never moves; its files icon opens or
 *  collapses the Explorer panel (E.3). Disabled until there's a session.
 *  DESKTOP ONLY (2026-07-25, Kyle): on ≤640px the strip is hidden — a
 *  permanent 46px rail is too much of a 390px screen — and the same toggle
 *  lives in the status bar instead (StatusBar's sb-files). */
function ActivityBar({
  filesOpen,
  disabled,
  onToggleFiles,
}: {
  filesOpen: boolean;
  disabled: boolean;
  onToggleFiles: () => void;
}) {
  return (
    <div className="activity-bar">
      <button
        className={"ab-btn ab-files" + (filesOpen ? " is-active" : "")}
        onClick={onToggleFiles}
        disabled={disabled}
        title={filesOpen ? "Hide files" : "Show files"}
        aria-label="Files"
        aria-expanded={filesOpen}
      >
        <FilesGlyph />
      </button>
    </div>
  );
}

/**
 * Stdin for the running `!` command (4.9) — SHELL-OWNED UI on the ephemeral
 * input path: what's typed here goes to the PTY and nowhere else (never the
 * replay ring, never other viewports), and only the issuing viewport mounts
 * it. Masks itself when the command's output ends in a password prompt
 * (echo-off input never comes back as output, so masking here is the only
 * echo there is); a toggle overrides the guess either way.
 */
function BangBar({
  command,
  tail,
  onInput,
  onKill,
}: {
  command: string;
  tail: string;
  onInput: (data: string) => void;
  onKill: () => void;
}) {
  const [val, setVal] = useState("");
  const [maskOverride, setMaskOverride] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastLine = tail.slice(tail.lastIndexOf("\n") + 1);
  const maskAuto = /pass(word|phrase)/i.test(lastLine) && /:\s*$/.test(lastLine);
  const masked = maskOverride ?? maskAuto;

  // A password prompt appearing is the moment the user wants to type here.
  useEffect(() => {
    if (maskAuto) inputRef.current?.focus();
  }, [maskAuto]);

  return (
    <div className="bang-bar">
      <span className="bang-bar-badge">!</span>
      <span className="bang-bar-cmd" title={command}>
        {command}
      </span>
      <input
        ref={inputRef}
        className="bang-bar-input"
        type={masked ? "password" : "text"}
        value={val}
        spellCheck={false}
        autoComplete="off"
        placeholder={masked ? "password — sent to the command only, never stored" : "stdin"}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onInput(val + "\n");
            setVal("");
            setMaskOverride(null); // re-detect on the next prompt
          } else if (e.key === "c" && e.ctrlKey) {
            e.preventDefault();
            onInput("\x03"); // SIGINT to the foreground process, like a terminal
          } else if (e.key === "Escape") {
            onKill();
          }
        }}
      />
      <button
        className="bang-bar-mask"
        onClick={() => setMaskOverride(!masked)}
        title={masked ? "Show what I type" : "Mask what I type"}
      >
        {masked ? "abc" : "•••"}
      </button>
      <button className="bang-bar-kill" onClick={onKill} title="Kill the command (Esc)">
        ■ kill
      </button>
    </div>
  );
}
