import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { ModalCard } from "./ModalCard";
import type { SubscriptionAct } from "../session-bus";
import {
  acting,
  confirmLede,
  describeSubscription,
  loading,
  onReply,
  type CardState,
  type SubscriptionReply,
} from "../subscription-card";

// The shell-owned "connect a device" affordance. The daemon hands local
// viewports the relay's HTTP origin + the pairing code (agents hello); this
// renders them as a QR of the pairing URL — the fragment form, so the code
// never appears in any HTTP request, only on this screen and the phone's.
// Trusted-shell surface end to end: agent output can never paint or read it.

// The hello's pairing info (protocol.ts `agents.relay`): `ws` is the relay's
// ws(s) origin, present when `url` is a separate static app origin — it rides
// the QR fragment so the loaded page knows where to dial.
export type { RelayInfo } from "../daemon-hello";
import type { AgentsHello, RelayInfo } from "../daemon-hello";

/** Why remote access is off (hello `relayOff`) — the card's state when there
 *  is no relay to draw a QR for. */
export type RelayOff = NonNullable<AgentsHello["relayOff"]>;

/** Where "get Mirafold Pro" goes. A plain link (new tab, no opener): the
 *  destination is visible on hover and nothing about it is scripted. */
export const PAY_URL = "https://mirafold.com/pay";

// Names the dialog for a screen reader. A constant is safe: the card is
// mounted only while open, and one status bar means one of these.
const TITLE_ID = "pair-card-title";

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
      {/* Literal black-on-white: QR modules are for camera
          scanners, not the theme — max contrast in every theme, never var(). */}
      <rect x={-2} y={-2} width={count + 4} height={count + 4} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

/** Mints + sends one subscription request; returns its id. */
export type SubscriptionRequest = (act: SubscriptionAct) => string;

// The manage-subscription view behind the neutral link below.
// Everything shown is shell-owned copy composed by subscription-card.ts;
// cancel sits behind its own confirm step quoting the real consequence, and
// a scheduled cancel offers undo for the whole remainder of the period.
function ManageSubscription({
  request,
  reply,
  titleId,
}: {
  request: SubscriptionRequest;
  reply: SubscriptionReply | null;
  titleId: string;
}) {
  const [state, setState] = useState<CardState>({ phase: "loading", waitId: "" });
  useEffect(() => {
    setState(loading(request("status")));
  }, [request]);
  useEffect(() => {
    if (reply) setState((s) => onReply(s, reply));
  }, [reply]);

  if (state.phase === "loading" || state.phase === "acting") {
    return <div className="sub-line sub-dim">{state.phase === "loading" ? "checking…" : "working…"}</div>;
  }
  if (state.phase === "failed") {
    return (
      <div role="alert">
        <div className="sub-line">{state.message}</div>
        <button className="sub-btn" onClick={() => setState(loading(request("status")))}>
          try again
        </button>
      </div>
    );
  }
  const { line, action } = describeSubscription(state.reply);
  if (state.confirming) {
    return (
      <div aria-labelledby={titleId}>
        <div className="sub-line">{confirmLede(state.reply)}</div>
        <div className="sub-actions">
          <button
            className="sub-btn"
            onClick={() => setState({ ...state, confirming: false })}
            autoFocus
          >
            keep subscription
          </button>
          <button
            className="sub-btn sub-btn-danger"
            onClick={() => setState(acting(request("cancel")))}
          >
            cancel subscription
          </button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="sub-line">{line}</div>
      {action === "cancel" && (
        <button className="sub-btn" onClick={() => setState({ ...state, confirming: true })}>
          cancel subscription…
        </button>
      )}
      {action === "uncancel" && (
        <button className="sub-btn" onClick={() => setState(acting(request("uncancel")))}>
          undo cancellation
        </button>
      )}
    </div>
  );
}

// The card's body when there is no relay: the honest reason, and — when the
// reason is that nothing is configured — the one way to get one. Shell-owned
// copy; the pay link is an ordinary anchor so the browser shows where it goes.
export function RemoteAccessOff({ reason }: { reason: RelayOff }) {
  if (reason === "unentitled") {
    return (
      <>
        <div className="pair-hint">
          Pair your phone and open this daemon's sessions from anywhere — end-to-end
          encrypted, through the Mirafold relay. Remote access is part of Mirafold Pro.
        </div>
        <a className="pair-cta" href={PAY_URL} target="_blank" rel="noopener noreferrer">
          get Mirafold Pro ↗
        </a>
        <div className="pair-hint pair-hint-sub">
          Already have a license key? Set <code>MIRAFOLD_LICENSE_KEY</code> and relaunch.
        </div>
      </>
    );
  }
  if (reason === "opt-out") {
    return (
      <div className="pair-hint">
        Remote access is turned off for this daemon (<code>MIRAFOLD_RELAY_URL=off</code>).
        Remove that setting and relaunch to pair a phone.
      </div>
    );
  }
  return (
    <div className="pair-hint">
      <code>MIRAFOLD_RELAY_URL</code> is not a valid <code>ws://</code> or <code>wss://</code>{" "}
      address, so remote access is off for this launch. Fix it and relaunch to pair a phone.
    </div>
  );
}

// `sessionId`: pairing from inside a session encodes that session into the
// fragment (`&s=<id>`) so the scanned phone lands IN it, not on the fleet
// list. Mission control's pair button passes nothing and keeps landing on the
// fleet — no special case.
// `billing` + `subRequest` + `subReply`: present when this daemon
// runs on a license key — the card then carries the neutral "manage
// subscription" link. Nothing cancel-shaped is ever passively visible: the
// resting UI shows only the pair button; cancel lives two deliberate steps
// deep, behind the link and its own confirm.
// `relayOff`: no relay, and this is why. The button is drawn all the same —
// every local viewport has one — and the card says what's true: the offer
// when nothing is configured, the setting to change otherwise. Neither field
// (a remote viewport) → nothing: the phone is already paired.
export function ConnectDevice({
  relay,
  relayOff,
  sessionId,
  billing,
  subRequest,
  subReply,
}: {
  relay?: RelayInfo;
  relayOff?: RelayOff;
  sessionId?: string;
  billing?: boolean;
  subRequest?: SubscriptionRequest;
  subReply?: SubscriptionReply | null;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manage, setManage] = useState(false);

  if (!relay && !relayOff) return null;
  const href = relay
    ? `${relay.url}/#code=${relay.code}${
        relay.ws ? `&relay=${encodeURIComponent(relay.ws)}` : ""
      }${sessionId ? `&s=${sessionId}` : ""}`
    : undefined;

  return (
    <>
      <button
        className="sb-pair"
        onClick={() => setOpen(true)}
        title={
          href
            ? "Connect a device — scan a QR to open this daemon's sessions on your phone"
            : "Connect a device — open this daemon's sessions on your phone with Mirafold Pro"
        }
      >
        ⧉ pair
      </button>
      {open && (
        <ModalCard
          overlayClass="pair-backdrop"
          cardClass="pair-card"
          titleId={TITLE_ID}
          onDismiss={() => {
            setOpen(false);
            setManage(false);
          }}
        >
          <div className="pair-head">
            <span className="glyph" aria-hidden="true">
              ❯
            </span>
            <span className="pair-title" id={TITLE_ID}>
              {manage ? "subscription" : "connect a device"}
            </span>
            <button
              className="pair-close"
              onClick={() => {
                setOpen(false);
                setManage(false);
              }}
              title="Close (Esc)"
              aria-label={manage ? "Close subscription" : "Close connect a device"}
            >
              ✕
            </button>
          </div>
          {!href ? (
            <RemoteAccessOff reason={relayOff as RelayOff} />
          ) : manage && subRequest ? (
            <>
              <ManageSubscription request={subRequest} reply={subReply ?? null} titleId={TITLE_ID} />
              <button className="pair-manage" onClick={() => setManage(false)}>
                ← back to pairing
              </button>
            </>
          ) : (
            <>
              <QrSvg text={href} />
              <div className="pair-hint">
                Scan from your phone. The pairing code rides the URL fragment — it never
                reaches the relay, and every frame is end-to-end encrypted.
              </div>
              {/* Can't scan? Copy the link and send it to your own phone. Copy is
                  the one action, full width; the URL below it wraps to a couple of
                  readable lines — a one-line box would scroll sideways. */}
              <button
                className="pair-copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(href).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "copied" : "copy link"}
              </button>
              <code className="pair-url" tabIndex={0}>
                {href}
              </code>
              {/* Deliberately neutral wording — the resting card
                  invites managing, never leaving; cancel appears only inside,
                  behind its own confirm. */}
              {billing && subRequest && (
                <button className="pair-manage" onClick={() => setManage(true)}>
                  manage subscription
                </button>
              )}
            </>
          )}
        </ModalCard>
      )}
    </>
  );
}
