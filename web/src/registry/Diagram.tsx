import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "@registry-spec";
import { THEMES } from "../themes/manifest";

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

/** The frame document: runtime + a bootstrap that waits for nonce-stamped
 *  source messages. Pure; exported for the Tier-1 test, which pins that agent
 *  source is NOT in the document. Diagrams follow the APP theme, unlike the
 *  pinned-dark code surfaces — a diagram is a picture, not a code surface, so
 *  each message re-initializes mermaid with the shell-computed dark flag and
 *  panel color; the body stays transparent so the panel surface is the canvas. */
export function diagramDoc(runtime: string, nonce: string): string {
  // <-escape keeps any string safe inside the inline <script>, though
  // the caller only ever passes a crypto.randomUUID().
  const boot =
    `(function(){var N=${JSON.stringify(nonce).replace(/</g, "\\u003c")};` +
    "function post(m){m.mirafoldDiagram=1;m.nonce=N;try{parent.postMessage(m,'*')}catch(e){}}" +
    "window.addEventListener('message',function(e){" +
    "var d=e.data;if(!d||d.mirafoldDiagram!==1||d.nonce!==N||typeof d.source!=='string')return;" +
    "var dark=d.dark!==false;" +
    "mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:dark?'dark':'default'," +
    "themeVariables:{darkMode:dark,background:typeof d.background==='string'?d.background:'#141a26'," +
    "fontFamily:\"system-ui,-apple-system,'Segoe UI',sans-serif\"}});" +
    "mermaid.render('mf-diagram',d.source).then(function(r){" +
    "document.getElementById('host').innerHTML=r.svg;" +
    "var s=document.querySelector('#host svg');if(s){s.style.maxWidth='100%'}" +
    "post({diagramReady:true,height:Math.ceil(document.documentElement.scrollHeight)});" +
    "},function(err){post({diagramError:String((err&&err.message)||err).slice(0,300)})});" +
    "});})();";
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${DIAGRAM_CSP}">` +
    "<style>html,body{margin:0;background:transparent}#host{padding:10px}</style>" +
    `<script>${runtime}</script>` +
    `<script>${boot}</script>` +
    '</head><body><div id="host"></div></body></html>'
  );
}

/** What the frame needs to draw on the current theme: the appearance side
 *  from the manifest (absent/unknown data-theme = the dark default) and the
 *  panel surface color mermaid derives its contrast colors against. */
function themeInfo(): { dark: boolean; background: string } {
  const id = document.documentElement.dataset["theme"];
  const appearance = THEMES.find((t) => t.id === id)?.appearance ?? "dark";
  const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  return { dark: appearance === "dark", background: surface || "#141a26" };
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

  // A theme switch must re-render the diagram itself (mermaid bakes its
  // colors into the SVG) — watch the root's data-theme stamp.
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  const post = () => {
    frameRef.current?.contentWindow?.postMessage(
      { mirafoldDiagram: 1, nonce, source, ...themeInfo() },
      "*",
    );
  };
  // Re-send when the source or theme changes after the frame already loaded.
  useEffect(() => {
    if (runtime) post();
  }, [source, runtime, themeTick]);

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
