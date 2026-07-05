import { useEffect, useMemo, useState } from "react";
import type { WireMsg } from "@protocol";
import { PromptBox } from "./PromptBox";
import { RenderZone } from "./RenderZone";
import { SocketClient } from "./ws";

/** What the output zone consumes: wire messages plus local user-turn echoes. */
export type ZoneMsg = WireMsg | { type: "user_prompt"; text: string };

/**
 * The trusted shell. Owns the socket and the prompt box; neither is ever
 * re-rendered or touched by agent output. The agent only paints into
 * RenderZone via the message bus below.
 */
export function Shell() {
  // Whether a turn is in flight — drives the stop affordance and Esc.
  // Set by the local user_prompt echo, cleared by the wire's turn_end.
  const [busy, setBusy] = useState(false);
  // Pending permission prompts, oldest first; the bar shows one at a time.
  // SHELL-OWNED UI: the agent can paint nothing here, so it can't fake it.
  const [asks, setAsks] = useState<{ tool: string; detail: string; id: string }[]>([]);

  const bus = useMemo(() => {
    const socket = new SocketClient();
    const listeners = new Set<(m: ZoneMsg) => void>();
    socket.onMessage((m) => {
      for (const l of listeners) l(m);
    });
    return {
      subscribe(l: (m: ZoneMsg) => void): () => void {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      sendPrompt(text: string) {
        socket.send({ type: "prompt", text });
        for (const l of listeners) l({ type: "user_prompt", text });
      },
      interrupt() {
        socket.send({ type: "interrupt" });
      },
      answerPermission(id: string, allow: boolean) {
        socket.send({ type: "permission_response", id, allow });
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
        }
      }),
    [bus],
  );

  const answer = (id: string, allow: boolean) => {
    bus.answerPermission(id, allow);
    setAsks((a) => a.filter((x) => x.id !== id));
  };

  // Esc interrupts from anywhere in the page, not just the textarea.
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") bus.interrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, bus]);

  return (
    <div className="shell">
      <RenderZone subscribe={bus.subscribe} />
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
    </div>
  );
}
