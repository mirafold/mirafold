import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";

// R.4: the shell-owned "connect a device" affordance. The daemon hands local
// viewports the relay's HTTP origin + the pairing code (agents hello); this
// renders them as a QR of the pairing URL — the fragment form, so the code
// never appears in any HTTP request, only on this screen and the phone's.
// Trusted-shell surface end to end: agent output can never paint or read it.

export type RelayInfo = { url: string; code: string };

function QrSvg({ text }: { text: string }) {
  // Error level M and auto type-number; modules become one <path>, drawn
  // black-on-white in BOTH themes — scanners want contrast, not theming.
  const { count, d } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let path = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
      }
    }
    return { count: n, d: path };
  }, [text]);
  return (
    <svg
      className="pair-qr"
      viewBox={`-2 -2 ${count + 4} ${count + 4}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="pairing QR code"
    >
      <rect x={-2} y={-2} width={count + 4} height={count + 4} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

export function ConnectDevice({ relay }: { relay?: RelayInfo }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!relay) return null;
  const href = `${relay.url}/#code=${relay.code}`;

  return (
    <>
      <button
        className="sb-pair"
        onClick={() => setOpen(true)}
        title="Connect a device — scan a QR to open this daemon's sessions on your phone"
      >
        ⧉ pair
      </button>
      {open && (
        <div className="pair-backdrop" onClick={() => setOpen(false)}>
          <div className="pair-card" onClick={(e) => e.stopPropagation()}>
            <div className="pair-head">
              <span className="glyph">❯</span>
              <span className="pair-title">connect a device</span>
              <button className="pair-close" onClick={() => setOpen(false)} title="Close (Esc)">
                ✕
              </button>
            </div>
            <QrSvg text={href} />
            <div className="pair-hint">
              Scan from your phone. The pairing code rides the URL fragment — it never
              reaches the relay, and every frame is end-to-end encrypted.
            </div>
            <div className="pair-url-row">
              <code className="pair-url">{href}</code>
              <button
                className="pair-copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(href).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "copied" : "copy"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
