import { useEffect, useRef } from "react";
import type { Action } from "@protocol";

/**
 * Level 3 host — the ONLY place agent-authored HTML/JS ever executes.
 *
 * Threat model (assume the artifact is hostile):
 *
 * - `sandbox="allow-scripts"` WITHOUT `allow-same-origin` gives the document
 *   an opaque origin: `document.cookie`, `localStorage`, `sessionStorage`,
 *   `indexedDB`, and `window.parent.document` all throw SecurityError. The
 *   shell's DOM, socket, and anything stored under the app origin are
 *   unreachable — not filtered, structurally absent.
 * - A CSP (`default-src 'none'`) is injected in a wrapper <head> that always
 *   precedes the content, cutting every network path: fetch, XHR, WebSocket,
 *   external <script>/<img>/font/CSS. Multiple CSPs intersect, so content
 *   shipping its own <meta> policy can only tighten this, never loosen it.
 * - No allow-popups / allow-top-navigation / allow-forms / allow-modals /
 *   allow-downloads: it can't open windows, navigate the shell, submit
 *   forms, block the UI with alert(), or write files.
 * - The html lands via React's `srcDoc` prop (attribute-escaped), so markup
 *   can't terminate the iframe element and spill into the shell document.
 * - The postMessage bridge (Step 3.3) is the ONE outward channel, and it is
 *   validated at every hop: the listener accepts messages only from THIS
 *   iframe's contentWindow AND only from the opaque origin ("null"), so no
 *   other frame — and not even this artifact after a self-navigation — can
 *   speak on it. The payload must parse as a prompt or tool Action (state
 *   ops and malformed shapes are dropped), it is rate-limited, and what
 *   passes still only reaches the server's Step 2.3 allowlist mediation —
 *   the bridge grants no capability a registry component doesn't have.
 * - Accepted residuals: (1) the artifact can navigate ITSELF (location=,
 *   <a>, meta refresh) to an external URL, which then loads in the same
 *   opaque-origin sandbox with the bridge dead (origin check) — a phishing
 *   surface, not a data one; Step 3.4's load/error handling is the place to
 *   detect and blank it. (2) Bridge actions need no user gesture, so a
 *   hostile artifact could auto-fire them; the rate limit caps the burn and
 *   every action lands as a visible transcript record.
 *
 * The "artifact · sandboxed" chrome is drawn by the shell, outside the
 * iframe — same rule as the pin affordance: the agent can't fake it.
 */

const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

// Base styles so bare artifact markup reads as part of the output zone;
// content can override them, but only inside its own opaque document.
const ARTIFACT_BASE_CSS =
  "body{margin:12px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;" +
  "font-size:14px;background:#141a26;color:#e6e9ef;color-scheme:dark}";

// The agent-facing bridge API, injected before the content. Convenience
// only — the security is in the parent-side validation, not here.
const ARTIFACT_BRIDGE_JS =
  "window.genui={" +
  "prompt:function(text){parent.postMessage({genui:1,action:{kind:'prompt',text:String(text)}},'*')}," +
  "tool:function(name,args){parent.postMessage({genui:1,action:Object.assign({kind:'tool',name:String(name)},args===undefined?{}:{args:args})},'*')}" +
  "};";

function wrap(html: string): string {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
    `<style>${ARTIFACT_BASE_CSS}</style>` +
    `<script>${ARTIFACT_BRIDGE_JS}</script>` +
    `</head><body>${html}</body></html>`
  );
}

// Minimum gap between accepted bridge actions — a click cadence, not a loop.
const ACTION_MIN_INTERVAL_MS = 400;

/** Strict parse of a bridge payload; anything not exactly right is null. */
function parseBridgeAction(data: unknown): Action | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d["genui"] !== 1) return null;
  const a = d["action"];
  if (typeof a !== "object" || a === null) return null;
  const act = a as Record<string, unknown>;
  if (
    act["kind"] === "prompt" &&
    typeof act["text"] === "string" &&
    act["text"].trim() !== "" &&
    act["text"].length <= 4000
  ) {
    return { kind: "prompt", text: act["text"] };
  }
  if (
    act["kind"] === "tool" &&
    typeof act["name"] === "string" &&
    act["name"].length <= 200 &&
    (act["args"] === undefined ||
      (typeof act["args"] === "object" && act["args"] !== null && !Array.isArray(act["args"])))
  ) {
    return {
      kind: "tool",
      name: act["name"],
      args: act["args"] as Record<string, unknown> | undefined,
    };
  }
  return null; // state ops and malformed shapes never leave the sandbox
}

export function Artifact({
  html,
  title,
  onAction,
}: {
  html: string;
  title?: string;
  onAction?: (action: Action) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const lastActionAt = useRef(0);

  useEffect(() => {
    if (!onAction) return;
    const onMsg = (e: MessageEvent) => {
      // Identity first: only THIS artifact's window, only its opaque origin.
      if (e.source !== frameRef.current?.contentWindow) return;
      if (e.origin !== "null") return;
      const action = parseBridgeAction(e.data);
      if (!action) return;
      const now = Date.now();
      if (now - lastActionAt.current < ACTION_MIN_INTERVAL_MS) return;
      lastActionAt.current = now;
      onAction(action);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onAction]);

  return (
    <div className="artifact">
      <div className="artifact-chrome">
        <span className="artifact-label">◱ {title ?? "artifact"}</span>
        <span className="artifact-badge">sandboxed</span>
      </div>
      <iframe
        ref={frameRef}
        className="artifact-frame"
        sandbox="allow-scripts"
        srcDoc={wrap(html)}
        referrerPolicy="no-referrer"
        title={title ?? "artifact"}
      />
    </div>
  );
}
