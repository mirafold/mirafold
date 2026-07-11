import { useEffect, useMemo, useRef, useState } from "react";
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
 *   iframe's contentWindow, only from the opaque origin ("null"), and only
 *   when stamped with the per-mount NONCE the boot script closes over — so
 *   no other frame, and no document that replaces this one, can speak on
 *   it. The payload must parse as a prompt or tool Action (state ops and
 *   malformed shapes are dropped), it is rate-limited, and what passes
 *   still only reaches the server's Step 2.3 allowlist mediation — the
 *   bridge grants no capability a registry component doesn't have.
 * - Self-navigation (location=, <a>, meta refresh) is detected (Step 3.4)
 *   by liveness, not load-counting: every wrapped document announces
 *   artifactReady (nonce-stamped) on its own load event, and the host
 *   expects that announce shortly after every frame load event. A foreign
 *   document can't know the nonce (it can't read its predecessor's source),
 *   so the announce never comes and the frame is unmounted — the fallback
 *   note takes its place. Note a navigated document KEEPS the opaque
 *   origin, so the origin check alone would not kill the bridge — the
 *   nonce is what does.
 * - Crashes are handled, not trusted (Step 3.4): an injected first-script
 *   hook reports uncaught errors/rejections over the postMessage channel.
 *   An early crash (artifact broken on arrival) swaps the frame for the
 *   source-as-code fallback; a late error only flags the chrome — a working
 *   UI isn't torn down for a stray exception. The hook is convenience, not
 *   security: a hostile artifact "faking" a crash only gets its own source
 *   printed.
 * - Accepted residual: bridge actions need no user gesture, so a hostile
 *   artifact could auto-fire them; the rate limit caps the burn and every
 *   action lands as a visible transcript record.
 *
 * The "artifact · sandboxed" chrome is drawn by the shell, outside the
 * iframe — same rule as the pin affordance: the agent can't fake it.
 */

const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

// Base styles so bare artifact markup reads as part of the output zone;
// content can override them, but only inside its own opaque document.
// Hardcoded hex (like the background): the opaque origin can't read the
// shell's CSS vars, so the scrollbar mirrors the dark theme's
// `scrollbar-color`/`scrollbar-width` from styles.css by value.
const ARTIFACT_BASE_CSS =
  "html{scrollbar-color:#3a4a68 transparent;scrollbar-width:thin}" +
  "body{margin:12px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;" +
  "font-size:14px;background:#141a26;color:#e6e9ef;color-scheme:dark}";

// First script in the document, closing over the per-mount nonce: the
// mirafold bridge API, the error hook, and the liveness announce. Every
// outbound message is nonce-stamped; the host drops anything unstamped.
function bootScript(nonce: string): string {
  return (
    `(function(){var N=${JSON.stringify(nonce)};var sent=false;` +
    "function post(m){m.mirafold=1;m.nonce=N;try{parent.postMessage(m,'*')}catch(e){}}" +
    "window.mirafold={" +
    "prompt:function(text){post({action:{kind:'prompt',text:String(text)}})}," +
    "tool:function(name,args){post({action:Object.assign({kind:'tool',name:String(name)},args===undefined?{}:{args:args})})}" +
    "};" +
    "window.addEventListener('error',function(e){if(sent)return;sent=true;post({artifactError:String(e.message||'script error').slice(0,300)})});" +
    "window.addEventListener('unhandledrejection',function(e){if(sent)return;sent=true;post({artifactError:String(e.reason||'unhandled rejection').slice(0,300)})});" +
    "window.addEventListener('load',function(){post({artifactReady:true})});" +
    "})();"
  );
}

// Exported for the R.4e Tier-1 sandbox tests only — not part of any API.
export function wrap(html: string, nonce: string): string {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
    `<style>${ARTIFACT_BASE_CSS}</style>` +
    `<script>${bootScript(nonce)}</script>` +
    `</head><body>${html}</body></html>`
  );
}

// Minimum gap between accepted bridge actions — a click cadence, not a loop.
const ACTION_MIN_INTERVAL_MS = 400;

// A crash inside this window means the artifact was broken on arrival →
// swap in the source fallback. Later errors only flag the chrome.
const EARLY_CRASH_WINDOW_MS = 2500;

// After a frame load event, how long the matching artifactReady announce
// may take. postMessage from the just-loaded document arrives within a
// task or two; a foreign document never sends it at all.
const READY_GRACE_MS = 400;

type Failure = { kind: "crash"; message: string } | { kind: "navigation" };

/** Strict parse of a bridge payload; anything not exactly right is null.
 *  Exported for the R.4e Tier-1 sandbox tests only — not part of any API. */
export function parseBridgeAction(data: unknown): Action | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d["mirafold"] !== 1) return null;
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
  pin,
}: {
  html: string;
  title?: string;
  onAction?: (action: Action) => void;
  // Pin/unpin lives in the shell-drawn chrome bar, outside the iframe — the
  // same trust rule as the badge: agent content can't fake or cover it.
  pin?: { pinned: boolean; onToggle: () => void };
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const lastActionAt = useRef(0);
  const readyCount = useRef(0);
  const loadCount = useRef(0);
  const mountedAt = useRef(Date.now());
  const [failure, setFailure] = useState<Failure | null>(null);
  const [lateError, setLateError] = useState<string | null>(null);

  // One nonce per artifact life; new html (update-in-place) mints a new one.
  const nonce = useMemo(() => crypto.randomUUID(), [html]);
  const srcDoc = useMemo(() => wrap(html, nonce), [html, nonce]);

  // New html = a new artifact life: reset failure state and the liveness
  // counters BEFORE the new document's load event can fire.
  useEffect(() => {
    loadCount.current = 0;
    readyCount.current = 0;
    mountedAt.current = Date.now();
    setFailure(null);
    setLateError(null);
  }, [html]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // Identity first: only THIS artifact's window, only its opaque origin,
      // only messages stamped with this life's nonce.
      if (e.source !== frameRef.current?.contentWindow) return;
      if (e.origin !== "null") return;
      const data = e.data as Record<string, unknown> | null;
      if (!data || data["mirafold"] !== 1 || data["nonce"] !== nonce) return;
      if (data["artifactReady"] === true) {
        readyCount.current += 1;
        return;
      }
      if (typeof data["artifactError"] === "string") {
        if (Date.now() - mountedAt.current < EARLY_CRASH_WINDOW_MS) {
          setFailure({ kind: "crash", message: data["artifactError"] });
        } else {
          setLateError(data["artifactError"]);
        }
        return;
      }
      if (!onAction) return;
      const action = parseBridgeAction(e.data);
      if (!action) return;
      const now = Date.now();
      if (now - lastActionAt.current < ACTION_MIN_INTERVAL_MS) return;
      lastActionAt.current = now;
      onAction(action);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onAction, nonce]);

  // Liveness check: every load event must be answered by a nonce-stamped
  // artifactReady. A document that replaced ours (self-navigation) can't
  // send it — and an immediate navigation aborts the wrapped document
  // before ITS load ever fires, so counting loads alone would miss it.
  const handleLoad = () => {
    loadCount.current += 1;
    const expected = loadCount.current;
    window.setTimeout(() => {
      if (readyCount.current < expected) setFailure({ kind: "navigation" });
    }, READY_GRACE_MS);
  };

  const pinBtn = pin && (
    <button
      className="artifact-pin"
      onClick={pin.onToggle}
      title={
        pin.pinned
          ? "Unpin — return to its place in the transcript"
          : "Pin — keep visible while the transcript scrolls"
      }
    >
      {pin.pinned ? "✕" : "📌"}
    </button>
  );

  if (failure) {
    return (
      <div className="artifact artifact-failed">
        <div className="artifact-chrome">
          <span className="artifact-label">◱ {title ?? "artifact"}</span>
          <span className="artifact-chrome-tools">
            <span className="artifact-badge artifact-badge-failed">
              {failure.kind === "navigation" ? "navigation blocked" : "failed"}
            </span>
            {pinBtn}
          </span>
        </div>
        <div className="artifact-fallback">
          <div className="artifact-fallback-note">
            {failure.kind === "navigation"
              ? "This artifact tried to navigate away and was blanked. Its source:"
              : `This artifact crashed (${failure.message}). Its source:`}
          </div>
          <pre className="artifact-source">
            <code>{html}</code>
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="artifact">
      <div className="artifact-chrome">
        <span className="artifact-label">◱ {title ?? "artifact"}</span>
        <span className="artifact-chrome-tools">
          {lateError ? (
            <span className="artifact-badge artifact-badge-warn" title={lateError}>
              ⚠ script error
            </span>
          ) : (
            <span className="artifact-badge">sandboxed</span>
          )}
          {pinBtn}
        </span>
      </div>
      <iframe
        ref={frameRef}
        className="artifact-frame"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        referrerPolicy="no-referrer"
        title={title ?? "artifact"}
        onLoad={handleLoad}
      />
    </div>
  );
}
