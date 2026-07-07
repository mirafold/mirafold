import { useEffect, useMemo, useRef, useState } from "react";
import type { Action, AgentName, WireMsg } from "@protocol";
import { Onboarding } from "./Onboarding";
import { PromptBox } from "./PromptBox";
import { RenderZone } from "./RenderZone";
import { StatusBar, type Usage } from "./StatusBar";
import { SocketClient } from "./ws";
import { tildify } from "./tildify";

const ZERO_USAGE: Usage = { turnIn: 0, turnOut: 0, sumIn: 0, sumOut: 0, cost: 0 };

/**
 * What the output zone consumes: the wire protocol plus one local control
 * message — zone_reset clears the transcript before a replay repaints it
 * (fired on a non-resumed session_created; a 4.4 tail resume skips it).
 */
export type ZoneMsg = WireMsg | { type: "zone_reset" };

/**
 * The trusted shell. Owns the socket and the prompt box; neither is ever
 * re-rendered or touched by agent output. The agent only paints into
 * RenderZone via the message bus below.
 *
 * Step 4.2: a connection is a viewport onto a registry session. The URL is
 * the session identity (/s/<id>) — refresh-safe and shareable across tabs.
 */
export function Shell() {
  // Whether a turn is in flight — drives the stop affordance and Esc.
  // Derived entirely from the wire: user_prompt sets it, turn_end clears it,
  // and a replayed in-flight turn therefore restores it correctly.
  const [busy, setBusy] = useState(false);
  // Pending permission prompts, oldest first; the bar shows one at a time.
  // SHELL-OWNED UI: the agent can paint nothing here, so it can't fake it.
  const [asks, setAsks] = useState<{ tool: string; detail: string; id: string }[]>([]);
  // Status-bar state (T2.6) — all shell-owned, none paintable by the agent.
  const [connected, setConnected] = useState(false);
  const [meta, setMeta] = useState<{ sessionId?: string; cwd?: string; agent?: AgentName }>({});
  const [usage, setUsage] = useState<Usage>(ZERO_USAGE);
  // P.4 onboarding: which agents the daemon offers, and whether we're still at
  // the picker. A URL that already names a session skips onboarding (it attaches).
  const [agents, setAgents] = useState<{ agent: AgentName; live: boolean }[] | null>(null);
  // 4.8: where the daemon was launched (the default session cwd) + home for
  // ~-abbreviation, both off the agents hello; and the last create error so
  // the onboarding card can show a rejected working dir.
  const [daemon, setDaemon] = useState<{ cwd?: string; home?: string }>({});
  const [onbError, setOnbError] = useState<string | null>(null);
  // 4.9: the `!` command THIS viewport issued, if still running — only the
  // issuer gets the stdin affordance (a sudo prompt must never fan out to a
  // second tab or, later, a phone via the relay). Lost on refresh: Tier 1.
  const [myBang, setMyBang] = useState<{ id: string; command: string } | null>(null);
  // Tail of the running command's output — drives the password-prompt
  // detection that masks the stdin field. One bang per session, so untagged.
  const [bangTail, setBangTail] = useState("");
  const hasUrlSession = useMemo(() => /^\/s\/[\w-]+/.test(location.pathname), []);

  // 4.3: theme is shell-owned UI state. Dark is the default and the identity;
  // index.html applies the stored choice before first paint (no flash) and
  // this keeps the attribute + storage in sync on toggle.
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("genui-theme") === "light" ? "light" : "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("genui-theme", theme);
  }, [theme]);

  const bus = useMemo(() => {
    const socket = new SocketClient();
    const listeners = new Set<(m: ZoneMsg) => void>();
    const connListeners = new Set<(c: boolean) => void>();
    // The URL carries the session identity; no id yet means "create one".
    let sessionId = location.pathname.match(/^\/s\/([\w-]+)/)?.[1] ?? null;
    // Attach to a known session; otherwise send nothing and wait at onboarding
    // (P.4 — no agent is assumed, so we don't auto-create). 4.4: the hello
    // names the last seq this viewport saw, asking for a tail-only resume.
    socket.setHello(() =>
      sessionId
        ? { type: "attach", sessionId, afterSeq: socket.lastSeq ?? undefined }
        : null,
    );
    socket.onOpen(() => {
      for (const c of connListeners) c(true);
    });
    socket.onClose(() => {
      for (const c of connListeners) c(false);
    });
    socket.onMessage((m) => {
      if (m.type === "session_created") {
        sessionId = m.sessionId;
        history.replaceState(null, "", `/s/${m.sessionId}`);
        // Full attach: the server replays the whole buffer next — clear the
        // zone so pre-attach residue never sits above the transcript (4.8).
        // Resumed attach (4.4): only the unseen tail follows — keep
        // everything (state, scroll, an in-flight streaming block).
        if (!m.resumed) {
          socket.lastSeq = null; // cursor restarts with the full replay
          for (const l of listeners) l({ type: "zone_reset" });
        }
      }
      for (const l of listeners) l(m);
    });
    return {
      subscribe(l: (m: ZoneMsg) => void): () => void {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      onConnection(cb: (c: boolean) => void): () => void {
        connListeners.add(cb);
        return () => {
          connListeners.delete(cb);
        };
      },
      // P.4: the user picked an agent at onboarding — create a session on it.
      // session_created sets `sessionId`, so a later reconnect re-attaches.
      // 4.8: `cwd` is the working dir typed at the picker; omitted → the
      // daemon's launch dir.
      createSession(agent: AgentName, cwd?: string) {
        socket.send({ type: "create", agent, cwd });
      },
      sendPrompt(text: string) {
        // No local echo — the server broadcasts the user_prompt to every
        // viewport (including this one), so all tabs stay identical.
        socket.send({ type: "prompt", text });
      },
      // 4.9: run a shell command in the session's cwd (the `!` path). The id
      // is minted here so this viewport can correlate the broadcast stream.
      sendBang(command: string): string {
        const id = `bang-${Math.random().toString(36).slice(2, 10)}`;
        socket.send({ type: "bang", command, id });
        return id;
      },
      // EPHEMERAL: PTY stdin (possibly a password) — the server writes it to
      // the process and nothing else; it never comes back on the wire.
      sendBangInput(id: string, data: string) {
        socket.send({ type: "bang_input", data, id });
      },
      killBang(id: string) {
        socket.send({ type: "bang_kill", id });
      },
      interrupt() {
        socket.send({ type: "interrupt" });
      },
      answerPermission(id: string, allow: boolean) {
        socket.send({ type: "permission_response", id, allow });
      },
      sendAction(action: Action, sourceId: string) {
        socket.send({ type: "action", action, sourceId });
      },
    };
  }, []);

  useEffect(
    () =>
      bus.subscribe((m) => {
        if (m.type === "user_prompt") setBusy(true);
        else if (m.type === "turn_end") {
          setBusy(false);
          setAsks([]); // a request that outlived its turn is void (server denies)
        } else if (m.type === "permission_request") {
          setAsks((a) => [...a, { tool: m.tool, detail: m.detail, id: m.id }]);
        } else if (m.type === "agents") {
          setAgents(m.agents);
          setDaemon({ cwd: m.cwd, home: m.home });
        } else if (m.type === "session_created") {
          setMeta({ sessionId: m.sessionId, cwd: m.cwd, agent: m.agent });
          setOnbError(null);
        } else if (m.type === "error") {
          // Only the onboarding card consumes this; in-session errors already
          // render in the output zone.
          setOnbError(m.message);
        } else if (m.type === "bang_start") {
          setBangTail("");
        } else if (m.type === "bang_output") {
          // Only the tail matters (prompt detection) — keep it tiny.
          setBangTail((t) => (t + m.data).slice(-400));
        } else if (m.type === "bang_end") {
          setMyBang((b) => (b && b.id === m.id ? null : b));
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

  useEffect(() => bus.onConnection(setConnected), [bus]);

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
        ? "⚠ permission — genui-shell"
        : state === "busy"
          ? "✳ working — genui-shell"
          : "genui-shell";
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
      setMyBang({ id: bus.sendBang(command), command });
      setBangTail("");
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
          agents={agents}
          defaultCwd={tildify(daemon.cwd, daemon.home)}
          error={onbError}
          onPick={(agent, cwd) => {
            setOnbError(null);
            bus.createSession(agent, cwd);
          }}
        />
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
      {myBang && (
        <BangBar
          command={myBang.command}
          tail={bangTail}
          onInput={(data) => bus.sendBangInput(myBang.id, data)}
          onKill={() => bus.killBang(myBang.id)}
        />
      )}
      <PromptBox
        onSend={send}
        busy={busy}
        onInterrupt={bus.interrupt}
        cwd={tildify(meta.cwd, daemon.home)}
      />
      <StatusBar
        connected={connected}
        agent={meta.agent}
        sessionId={meta.sessionId}
        cwd={meta.cwd}
        usage={usage}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
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
