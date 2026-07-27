import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "@registry-spec";

// Mermaid diagrams, rendered INSIDE the artifact-grade sandbox — never in the
// shell origin. Mermaid is a large parser with a sanitization-CVE history;
// under the trusted-shell rule its output is agent-derived markup, so it runs
// where agent markup runs: an opaque-origin iframe with a no-network CSP.
// The division of trust:
//   - the RUNTIME (mermaid.min.js) is shell-supplied, inlined into the frame;
//   - the agent's diagram SOURCE arrives by postMessage only — it is never
//     interpolated into the document, so it cannot break out of the markup;
//   - the frame answers on a per-mount nonce (the Artifact pattern): ready +
//     measured height, or a parse error the shell shows with the source.
// The runtime is a ~3.6 MB lazy chunk, loaded the first time any diagram
// renders — sessions without diagrams never pay for it.

const DIAGRAM_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** The frame document: runtime + a bootstrap that waits for THE one
 *  nonce-stamped source message. Pure; exported for the Tier-1 test, which
 *  pins that agent source is NOT in the document. */
export function diagramDoc(runtime: string, nonce: string): string {
  // <-escape keeps any string safe inside the inline <script>, though
  // the caller only ever passes a crypto.randomUUID().
  const boot =
    `(function(){var N=${JSON.stringify(nonce).replace(/</g, "\\u003c")};` +
    "function post(m){m.mirafoldDiagram=1;m.nonce=N;try{parent.postMessage(m,'*')}catch(e){}}" +
    "mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'dark'," +
    "themeVariables:{darkMode:true,background:'#141a26',fontFamily:\"system-ui,-apple-system,'Segoe UI',sans-serif\"}});" +
    "window.addEventListener('message',function(e){" +
    "var d=e.data;if(!d||d.mirafoldDiagram!==1||d.nonce!==N||typeof d.source!=='string')return;" +
    "mermaid.render('mf-diagram',d.source).then(function(r){" +
    "document.getElementById('host').innerHTML=r.svg;" +
    "var s=document.querySelector('#host svg');if(s){s.style.maxWidth='100%'}" +
    "post({diagramReady:true,height:Math.ceil(document.documentElement.scrollHeight)});" +
    "},function(err){post({diagramError:String((err&&err.message)||err).slice(0,300)})});" +
    "});})();";
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${DIAGRAM_CSP}">` +
    "<style>html,body{margin:0;background:#141a26}#host{padding:10px}</style>" +
    `<script>${runtime}</script>` +
    `<script>${boot}</script>` +
    '</head><body><div id="host"></div></body></html>'
  );
}

/** The lazily-loaded mermaid runtime source, shared by every diagram. */
let runtimePromise: Promise<string> | null = null;
function loadRuntime(): Promise<string> {
  runtimePromise ??= import("mermaid/dist/mermaid.min.js?raw").then((m) => m.default);
  return runtimePromise;
}

export function Diagram({ title, source }: ComponentProps<"diagram">) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [runtime, setRuntime] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nonce = useMemo(() => crypto.randomUUID(), []);
  const srcDoc = useMemo(() => (runtime ? diagramDoc(runtime, nonce) : null), [runtime, nonce]);

  useEffect(() => {
    let alive = true;
    loadRuntime().then(
      (src) => alive && setRuntime(src),
      () => alive && setError("diagram runtime failed to load"),
    );
    return () => {
      alive = false;
    };
  }, []);

  // New source on the same wire id = a new render pass through the same frame.
  useEffect(() => {
    setError(null);
    setHeight(null);
  }, [source]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      if (e.origin !== "null") return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || d["mirafoldDiagram"] !== 1 || d["nonce"] !== nonce) return;
      if (d["diagramReady"] === true && typeof d["height"] === "number") {
        setHeight(Math.min(Math.max(60, d["height"]), 2000));
      } else if (typeof d["diagramError"] === "string") {
        setError(d["diagramError"]);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [nonce]);

  const post = () => {
    frameRef.current?.contentWindow?.postMessage(
      { mirafoldDiagram: 1, nonce, source },
      "*",
    );
  };
  // Re-send when source changes after the frame already loaded.
  useEffect(() => {
    if (runtime) post();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, runtime]);

  if (error) {
    return (
      <div className="rc rc-diagram rc-diagram-failed">
        {title && <div className="rc-title">{title}</div>}
        <div className="rc-diagram-error">diagram didn't render — {error}</div>
        <pre className="rc-diagram-source">
          <code>{source}</code>
        </pre>
      </div>
    );
  }
  return (
    <div className="rc rc-diagram">
      <div className="rc-diagram-head">
        <span className="rc-diagram-title">{title ?? "diagram"}</span>
        <span className="rc-diagram-badge">sandboxed</span>
      </div>
      {srcDoc ? (
        <iframe
          ref={frameRef}
          className="rc-diagram-frame"
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          referrerPolicy="no-referrer"
          title={title ?? "diagram"}
          onLoad={post}
          style={height ? { height: `${height}px` } : undefined}
        />
      ) : (
        <div className="rc-diagram-loading">rendering diagram…</div>
      )}
    </div>
  );
}
