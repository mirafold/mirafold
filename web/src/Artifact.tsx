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
 * - `window.parent` remains reachable as an opaque WindowProxy — that is
 *   deliberate: it is the postMessage seam Step 3.3 builds the mediated
 *   action bridge on. Until then the shell listens for nothing.
 * - Accepted residual: the artifact can navigate ITSELF (location=, <a>,
 *   meta refresh) to an external URL, which then loads inside the same
 *   opaque-origin sandbox. It gains no shell access and the artifact holds
 *   no secrets to exfiltrate beyond what the agent already wrote into it,
 *   so this is a phishing surface, not a data one. Step 3.4's load/error
 *   handling is the place to detect and blank such navigations.
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

function wrap(html: string): string {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
    `<style>${ARTIFACT_BASE_CSS}</style>` +
    `</head><body>${html}</body></html>`
  );
}

export function Artifact({ html, title }: { html: string; title?: string }) {
  return (
    <div className="artifact">
      <div className="artifact-chrome">
        <span className="artifact-label">◱ {title ?? "artifact"}</span>
        <span className="artifact-badge">sandboxed</span>
      </div>
      <iframe
        className="artifact-frame"
        sandbox="allow-scripts"
        srcDoc={wrap(html)}
        referrerPolicy="no-referrer"
        title={title ?? "artifact"}
      />
    </div>
  );
}
