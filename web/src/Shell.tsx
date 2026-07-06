import { useEffect, useMemo, useState } from "react";
import type { Action, AgentName, WireMsg } from "@protocol";
import { Onboarding } from "./Onboarding";
import { PromptBox } from "./PromptBox";
import { RenderZone } from "./RenderZone";
import { StatusBar, type Usage } from "./StatusBar";
import { SocketClient } from "./ws";

const ZERO_USAGE: Usage = { turnIn: 0, turnOut: 0, sumIn: 0, sumOut: 0, cost: 0 };

/**
 * What the output zone consumes: the wire protocol plus one local control
 * message — zone_reset clears the transcript before a replay repaints it
 * (fired on every socket open, Step 4.2).
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
  const hasUrlSession = useMemo(() => /^\/s\/[\w-]+/.test(location.pathname), []);

  const bus = useMemo(() => {
    const socket = new SocketClient();
    const listeners = new Set<(m: ZoneMsg) => void>();
    const connListeners = new Set<(c: boolean) => void>();
    // The URL carries the session identity; no id yet means "create one".
    let sessionId = location.pathname.match(/^\/s\/([\w-]+)/)?.[1] ?? null;
    // Attach to a known session; otherwise send nothing and wait at onboarding
    // (P.4 — no agent is assumed, so we don't auto-create).
    socket.setHello(() => (sessionId ? { type: "attach", sessionId } : null));
    // Every (re)open replays history — clear the zone so it repaints once.
    socket.onOpen(() => {
      for (const l of listeners) l({ type: "zone_reset" });
      for (const c of connListeners) c(true);
    });
    socket.onClose(() => {
      for (const c of connListeners) c(false);
    });
    socket.onMessage((m) => {
      if (m.type === "session_created") {
        sessionId = m.sessionId;
        history.replaceState(null, "", `/s/${m.sessionId}`);
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
      createSession(agent: AgentName) {
        socket.send({ type: "create", agent });
      },
      sendPrompt(text: string) {
        // No local echo — the server broadcasts the user_prompt to every
        // viewport (including this one), so all tabs stay identical.
        socket.send({ type: "prompt", text });
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
        } else if (m.type === "session_created") {
          setMeta({ sessionId: m.sessionId, cwd: m.cwd, agent: m.agent });
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

  // Onboarding shows until this viewport has a session — but not when the URL
  // already names one (that path attaches straight through).
  const showOnboarding = !hasUrlSession && !meta.sessionId;

  return (
    <div className="shell">
      {showOnboarding && <Onboarding agents={agents} onPick={bus.createSession} />}
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
      <PromptBox onSend={bus.sendPrompt} busy={busy} onInterrupt={bus.interrupt} />
      <StatusBar
        connected={connected}
        agent={meta.agent}
        sessionId={meta.sessionId}
        cwd={meta.cwd}
        usage={usage}
      />
    </div>
  );
}
