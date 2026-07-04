import { useMemo } from "react";
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
    };
  }, []);

  return (
    <div className="shell">
      <RenderZone subscribe={bus.subscribe} />
      <PromptBox onSend={bus.sendPrompt} />
    </div>
  );
}
