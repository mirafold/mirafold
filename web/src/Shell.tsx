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
    };
  }, []);

  useEffect(
    () =>
      bus.subscribe((m) => {
        if (m.type === "user_prompt") setBusy(true);
        else if (m.type === "turn_end") setBusy(false);
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

  return (
    <div className="shell">
      <RenderZone subscribe={bus.subscribe} />
      <PromptBox onSend={bus.sendPrompt} busy={busy} onInterrupt={bus.interrupt} />
    </div>
  );
}
