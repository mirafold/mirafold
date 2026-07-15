import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentName } from "@protocol";
import { Onboarding } from "./Onboarding";
import { PromptBox } from "./PromptBox";
import { RenderZone } from "./RenderZone";
import { StatusBar, type Usage } from "./StatusBar";
import { createSessionBus } from "./session-bus";
import { tildify } from "./tildify";
import { agentLabel, connectHint } from "./agents-meta";

// The zone-message type lives with the bus (H.9); re-exported so consumers
// of the shell's contract (RenderZone) keep their import site.
export type { ZoneMsg } from "./session-bus";

const ZERO_USAGE: Usage = { turnIn: 0, turnOut: 0, sumIn: 0, sumOut: 0, cost: 0 };

/**
 * The trusted shell. Owns the socket and the prompt box; neither is ever
 * re-rendered or touched by agent output. The agent only paints into
 * RenderZone via the message bus below.
 *
 * Step 4.2: a connection is a viewport onto a registry session. The URL is
 * the session identity (/s/<id>) — refresh-safe and shareable across tabs.
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
  const [meta, setMeta] = useState<{
    sessionId?: string;
    cwd?: string;
    agent?: AgentName;
    demo?: boolean;
  }>({});
  const [usage, setUsage] = useState<Usage>(ZERO_USAGE);
  // Everything the daemon's `agents` hello carries, kept together: which
  // agents it offers (P.4 onboarding; a URL that already names a session
  // skips the picker), where it was launched (4.8 — the default session cwd)
  // + home for ~-abbreviation, the pairing info for the "connect a device"
  // QR (R.4, local viewports only), and its build version.
  const [daemonInfo, setDaemonInfo] = useState<{
    agents: { agent: AgentName; live: boolean; blocked?: boolean; detail?: string }[] | null;
    cwd?: string;
    home?: string;
    relay?: { url: string; code: string; ws?: string };
    version?: string;
  }>({ agents: null });

  // ── The dismissable notices (all SHELL-OWNED — the agent paints none) ───
  const [notices, setNotices] = useState<{
    // R.4c: the server took the attach-fallback branch — the session this tab
    // asked for is gone (daemon restart, expiry) and this is a FRESH one. A
    // silent URL swap over a blank transcript reads as data loss with no
    // explanation; this shell-drawn notice says what happened. Cleared on
    // dismiss or on the first prompt into the new session.
    session: boolean;
    // R.4i: the daemon refused this REMOTE viewport because the session runs
    // on a subscription login, which can't be driven over the paid relay.
    // Shown until dismissed.
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

  // ── The theme (4.3) ─────────────────────────────────────────────────────
  // Theme is shell-owned UI state. Dark is the default and the identity;
  // index.html applies the stored choice before first paint (no flash) and
  // this keeps the attribute + storage in sync on toggle.
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("mirafold-theme") === "light" ? "light" : "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("mirafold-theme", theme);
  }, [theme]);

  // The socket + pub/sub live in session-bus.ts (H.9); one bus per mount,
  // exactly as the inline useMemo built it.
  const bus = useMemo(() => createSessionBus(), []);

  useEffect(
    () =>
      bus.subscribe((m) => {
        if (m.type === "user_prompt") {
          setBusy(true);
          // They've moved on in the new session — the R.4c notice is done.
          setNotices((n) => (n.session ? { ...n, session: false } : n));
        } else if (
          m.type === "status" ||
          m.type === "thinking_delta" ||
          m.type === "text_delta" ||
          m.type === "tool_use"
        ) {
          // R.4c: busy re-derives from ANY turn activity, not just the
          // user_prompt — a tail resume mid-turn replays none of the turn's
          // opening frames, and busy was cleared on the disconnect.
          setBusy(true);
        } else if (m.type === "turn_end") {
          setBusy(false);
          setAsks([]); // a request that outlived its turn is void (server denies)
        } else if (m.type === "permission_request") {
          setAsks((a) => [...a, { tool: m.tool, detail: m.detail, id: m.id }]);
        } else if (m.type === "agents") {
          setDaemonInfo({
            agents: m.agents,
            cwd: m.cwd,
            home: m.home,
            relay: m.relay,
            version: m.version,
          });
        } else if (m.type === "session_created") {
          setMeta({ sessionId: m.sessionId, cwd: m.cwd, agent: m.agent, demo: m.demo });
          setNotices((n) => ({
            ...n,
            onboarding: null,
            ...(m.fallback ? { session: true } : {}),
          }));
        } else if (m.type === "refused") {
          // R.4i: no session — the relay refused this subscription-backed
          // attach. Show the reason (also surfaced at onboarding if we're there).
          setNotices((n) => ({ ...n, refused: m.message, onboarding: m.message }));
        } else if (m.type === "error") {
          // Only the onboarding card consumes this; in-session errors already
          // render in the output zone.
          setNotices((n) => ({ ...n, onboarding: m.message }));
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
        }
      }),
    [bus],
  );

  useEffect(
    () =>
      bus.onConnection((c) => {
        setConnected(c);
        // R.4c: a dropped socket can't be mid-turn from this viewport's point
        // of view — clear the working state and the ■ esc stop affordance so
        // a dead daemon doesn't look like an agent still thinking. Replay (or
        // the turn-activity frames above) re-derives busy after reconnect.
        if (!c) setBusy(false);
      }),
    [bus],
  );

  // Esc interrupts from anywhere in the page, not just the textarea.
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") bus.interrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, bus]);

  // The browser tab is a status light: title + favicon reflect session state
  // so a row of tabs reads as a fleet view (Step 4.2).
  useEffect(() => {
    const state = asks.length > 0 ? "permission" : busy ? "busy" : "idle";
    document.title =
      state === "permission"
        ? "⚠ permission — Mirafold"
        : state === "busy"
          ? "✳ working — Mirafold"
          : "Mirafold";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.beginPath();
    ctx.arc(16, 16, 10, 0, Math.PI * 2);
    ctx.fillStyle =
      state === "permission" ? "#d4a852" : state === "busy" ? "#7ab8ff" : "#4ade80";
    ctx.fill();
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = canvas.toDataURL("image/png");
  }, [busy, asks.length]);

  const answer = (id: string, allow: boolean) => {
    bus.answerPermission(id, allow);
    setAsks((a) => a.filter((x) => x.id !== id));
  };

  // 4.9: a leading `!` is intercepted by the trusted shell and runs as a real
  // shell command — instant, zero tokens, never routed through the model.
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
      {showOnboarding && (
        <Onboarding
          agents={daemonInfo.agents}
          defaultCwd={tildify(daemonInfo.cwd, daemonInfo.home)}
          error={notices.onboarding}
          onPick={(agent, cwd) => {
            setNotices((n) => ({ ...n, onboarding: null }));
            bus.createSession(agent, cwd);
          }}
        />
      )}
      {notices.session && (
        // R.4c: SHELL-OWNED notice — honest about the swap the server made.
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
        // R.4i: SHELL-OWNED — the relay refused a subscription-backed session.
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
        // R.4b: SHELL-OWNED banner — the agent paints nothing here, so a demo
        // session is unmistakably labeled and the label can't be faked or
        // cleared (same trust rule as the permission bar).
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
      <RenderZone subscribe={bus.subscribe} sendAction={bus.sendAction} />
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
        agent={meta.agent}
        sessionId={meta.sessionId}
        cwd={meta.cwd}
        usage={usage}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        onEndSession={meta.sessionId ? bus.endSession : undefined}
        relay={daemonInfo.relay}
        version={daemonInfo.version}
      />
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
