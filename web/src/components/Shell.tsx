import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, AgentName, PromptOption } from "@protocol";
import { ActivityLine, activityLabel, type Activity } from "./ActivityLine";
import { BangBar } from "./BangBar";
import { ChangesGlyph } from "./ChangesGlyph";
import { FilesGlyph } from "./FilesGlyph";
import { Onboarding } from "./Onboarding";
import { PromptBox, type PromptDraft } from "./PromptBox";
import { RenderZone } from "./RenderZone";
import { FilesPanel } from "./files/FilesPanel";
import { ChangesPanel } from "./changes/ChangesPanel";
import type { WorkspaceSurface } from "./WorkspaceTabs";
import { StatusBar, type Usage } from "./StatusBar";
import { createSessionBus } from "../session-bus";
import type { SubscriptionReply } from "../subscription-card";
import { nextOpenTurns } from "../turn-busy";
import { traceTurn } from "../turn-trace";
import {
  MODE_STORAGE_KEY,
  THEMES,
  resolveSlot,
  slotStorageKey,
  type ThemeAppearance,
} from "../themes/manifest";
import { ThemePicker } from "./ThemePicker";
import { tildify } from "../tildify";
import { agentLabel, connectHint } from "../agents-meta";
import { paintTabStatus } from "../tab-status";
import { createDomNotifier, folderTitle, notifyPrefEnabled, setNotifyPref } from "../notify";
import { createFileDrop, quoteForPrompt, type UploadEntry } from "../file-drop";
import type { WireMsg } from "@protocol";
import { useEscapeKey } from "../use-escape";
import { Announcer, turnResponse, useAnnouncer } from "./Announcer";
import { PermBar, type PermAsk } from "./PermBar";
import type { InputNavigationDirection } from "../input-navigation";
import type {
  InputNavigationHandle,
  InputNavigationState,
} from "../use-input-navigation";

const ZERO_USAGE: Usage = { turnIn: 0, turnOut: 0, sumIn: 0, sumOut: 0, cost: 0 };

/**
 * The trusted shell. Owns the socket and the prompt box; neither is ever
 * re-rendered or touched by agent output. The agent only paints into
 * RenderZone via the message bus below.
 *
 * A connection is a viewport onto a registry session. The URL is
 * the session identity (/s/<id>) — refresh-safe and shareable across tabs (4.2).
 */
export function Shell() {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptContainerRef = useRef<HTMLDivElement>(null);
  // RenderZone owns transcript destinations; Shell bridges that controller to
  // the prompt keyboard entry and the phone-only disclosure state.
  const inputNavigationRef = useRef<InputNavigationHandle>(null);
  const [inputNavigationState, setInputNavigationState] = useState<InputNavigationState>({
    position: null,
    total: 0,
  });
  const [phoneInputNavigationOpen, setPhoneInputNavigationOpen] = useState(false);
  const closeInputNavigation = useCallback(() => {
    setPhoneInputNavigationOpen(false);
    inputNavigationRef.current?.close();
  }, []);
  const focusPrompt = useCallback(() => {
    closeInputNavigation();
    promptRef.current?.focus({ preventScroll: true });
  }, [closeInputNavigation]);
  const updateInputNavigationState = useCallback((next: InputNavigationState) => {
    setInputNavigationState(next);
    if (next.total < 2) setPhoneInputNavigationOpen(false);
  }, []);
  const openPhoneInputNavigation = useCallback(() => {
    if (inputNavigationRef.current?.openAtViewport()) {
      setPhoneInputNavigationOpen(true);
    }
  }, []);
  const movePhoneInputNavigation = useCallback((direction: InputNavigationDirection) => {
    inputNavigationRef.current?.move(direction, false);
  }, []);
  const navigateToLatestInput = useCallback(
    () => inputNavigationRef.current?.openLatest() ?? false,
    [],
  );
  // ── The turn ──────────────────────────────────────────────────────────
  // Whether a turn is in flight — drives the stop affordance, Esc, and the
  // activity indicator. Derived entirely from the wire: user_prompt sets it,
  // turn_end clears it, and a replayed in-flight turn therefore restores it
  // correctly.
  const [busy, setBusy] = useState(false);
  // Unanswered prompts in flight, counted off the wire (user_prompt up,
  // turn_end down). A bare flag can't cover the queued follow-up: one
  // prompt may be sent mid-turn (registry queues it), and flipping idle at
  // the FIRST turn_end would blank the indicator exactly while the engine
  // starts into the queued turn — an API round trip of real work with
  // nothing on screen (2026-07-29, Kyle). Replay-safe: the ring replays
  // prompt/end pairs in order and trims oldest-first, so an unmatched
  // turn_end can only under-count — the clamp absorbs it.
  const openTurns = useRef(0);
  // What the indicator says the turn is doing right now — the engine's last
  // status frame (or announced tool), cleared back to the generic "working…"
  // the moment it could go stale (tool_result, streamed text, turn_end).
  const [activity, setActivity] = useState<Activity>(null);
  // Pending permission prompts, oldest first; the bar shows one at a time.
  // SHELL-OWNED UI: the agent can paint nothing here, so it can't fake it.
  const [asks, setAsks] = useState<PermAsk[]>([]);
  // Mirror for the bus subscription (a stable closure): lets the
  // permission_resolved handler know whether the ask was still showing HERE —
  // i.e. it was answered elsewhere / timed out — without re-subscribing on
  // every asks change.
  const asksRef = useRef(asks);
  asksRef.current = asks;

  // ── The session + daemon (status-bar state, T2.6 — all shell-owned) ─────
  const [connected, setConnected] = useState(false);
  // A relay refusal reason while disconnected (R.4: no daemon / at capacity /
  // origin), surfaced in the status indicator; undefined = an ordinary drop.
  const [connNote, setConnNote] = useState<string | undefined>(undefined);
  const [meta, setMeta] = useState<{
    sessionId?: string;
    cwd?: string;
    agent?: AgentName;
    model?: string;
    demo?: boolean;
  }>({});
  const [usage, setUsage] = useState<Usage>(ZERO_USAGE);
  // Provider-owned pre-submit catalog (`/` commands, Codex `$` skills).
  // Replaced whole whenever the adapter reports a changed catalog.
  const [promptOptions, setPromptOptions] = useState<PromptOption[]>([]);
  // Everything the daemon's `agents` hello carries, kept together: which
  // agents it offers (P.4 onboarding; a URL that already names a session
  // skips the picker), where it was launched (4.8 — the default session cwd)
  // + home for ~-abbreviation, the pairing info for the "connect a device"
  // QR (R.4, local viewports only), and its build version.
  const [daemonInfo, setDaemonInfo] = useState<{
    agents: AgentInfo[] | null;
    cwd?: string;
    home?: string;
    folderPicker?: boolean;
    relay?: { url: string; code: string; ws?: string };
    version?: string;
    billing?: "license-key";
  }>({ agents: null });
  // Phase CS: the latest `subscription` reply — the pair card's manage view
  // correlates it by id, so holding just the newest one is enough.
  const [subReply, setSubReply] = useState<SubscriptionReply | null>(null);

  // ── The dismissable notices (all SHELL-OWNED — the agent paints none) ───
  const [notices, setNotices] = useState<{
    // The server took the attach-fallback branch — the session this tab asked
    // for is genuinely unknown (ended/removed, or predates durable recovery)
    // and this is a FRESH one. A silent URL swap over a blank transcript reads
    // as data loss with no explanation; this shell-drawn notice says what
    // happened. Cleared on dismiss or the first prompt into the new session.
    session: boolean;
    // The daemon refused this REMOTE viewport because the session runs
    // on a subscription login, which can't be driven over the paid relay.
    // Shown until dismissed (R.4i).
    refused: string | null;
    // The last create error, so the onboarding card can show a rejected
    // working dir (4.8).
    onboarding: string | null;
  }>({ session: false, refused: null, onboarding: null });

  // ── The `!` command (4.9) ───────────────────────────────────────────────
  const [bang, setBang] = useState<{
    // The bang THIS viewport issued, if still running — only the issuer gets
    // the stdin affordance (a sudo prompt must never fan out to a second tab
    // or, later, a phone via the relay). Lost on refresh: Tier 1.
    my: { id: string; command: string } | null;
    // Tail of the running command's output — drives the password-prompt
    // detection that masks the stdin field. One bang per session, so untagged.
    tail: string;
  }>({ my: null, tail: "" });

  const hasUrlSession = useMemo(() => /^\/s\/[\w-]+/.test(location.pathname), []);

  // ── The auxiliary workspace ─────────────────────────────────────────────
  // Exactly one shell-owned side surface can be open: Files answers what
  // exists; Changes answers what differs from Git HEAD. This single slot is
  // the invariant that keeps the transcript visible on desktop and prevents
  // stacked full-screen layers on phone.
  const [auxiliary, setAuxiliary] = useState<WorkspaceSurface | null>(null);
  const filesOpen = auxiliary === "files";
  const changesOpen = auxiliary === "changes";
  const [reviewPromptVisible, setReviewPromptVisible] = useState(false);
  const [promptDraft, setPromptDraft] = useState<PromptDraft>();
  const promptDraftId = useRef(0);
  const createReviewDraft = useCallback((text: string) => {
    promptDraftId.current += 1;
    setPromptDraft({ id: promptDraftId.current, text });
    setReviewPromptVisible(true);
  }, []);
  const toggleAuxiliary = (surface: WorkspaceSurface) => {
    if (surface !== "changes" || auxiliary !== "changes") setReviewPromptVisible(false);
    setAuxiliary((current) => (current === surface ? null : surface));
  };
  const closeAuxiliary = () => {
    setAuxiliary(null);
    setReviewPromptVisible(false);
  };
  // Phone (2026-08-18, Kyle): the status bar carries ONE workspace toggle,
  // not two side-by-side icons; it reopens whichever surface was used last
  // (Files until Changes has been chosen once), and the drawer's own head
  // switches between them. Desktop keeps the two-icon rail unchanged.
  const lastSurface = useRef<WorkspaceSurface>("files");
  if (auxiliary) lastSurface.current = auxiliary;
  const toggleWorkspace = () => toggleAuxiliary(lastSurface.current);
  const switchAuxiliary = (surface: WorkspaceSurface) => {
    if (auxiliary !== surface) toggleAuxiliary(surface);
  };

  // ── The theme (4.3; two-slot model S.3) ─────────────────────────────────
  // Theme is shell-owned UI state. Dark is the default and the identity;
  // index.html applies the stored choice before first paint (no flash) and
  // this keeps the attribute + storage in sync on toggle. The mode is which
  // side of the pill is active; each side resolves to a theme id through
  // its settings slot (defaults: the built-in pair, which makes this
  // byte-identical to the pre-slot behavior). The pill itself is LOCKED
  // unchanged (Phase S charter): two positions, mode in, mode out.
  const [mode, setMode] = useState<ThemeAppearance>(() =>
    localStorage.getItem(MODE_STORAGE_KEY) === "light" ? "light" : "dark",
  );
  const [slots, setSlots] = useState<Record<ThemeAppearance, string>>(() => ({
    light: resolveSlot("light", localStorage.getItem(slotStorageKey("light"))),
    dark: resolveSlot("dark", localStorage.getItem(slotStorageKey("dark"))),
  }));
  useEffect(() => {
    document.documentElement.dataset.theme = slots[mode];
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    localStorage.setItem(slotStorageKey("light"), slots.light);
    localStorage.setItem(slotStorageKey("dark"), slots.dark);
  }, [mode, slots]);
  // Settings card (S.4). Picking a theme fills its appearance side's slot
  // and switches to that side so the pick paints immediately — picking is
  // seeing. Appearance fit is enforced here, the one place slots are written.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pickTheme = (id: string) => {
    const entry = THEMES.find((t) => t.id === id);
    if (!entry) return;
    setSlots((s) => ({ ...s, [entry.appearance]: id }));
    setMode(entry.appearance);
  };

  // ── Needs-you notifications (Phase NF) ──────────────────────────────────
  // Preference + the browser's own grant, both shell-owned. Off by default;
  // flipping it on is the ONLY thing that asks the browser for notification
  // permission (never page load). "unsupported" (iOS Safari outside an
  // installed PWA) hides the settings section entirely.
  const [notifyOn, setNotifyOn] = useState(
    () => typeof Notification !== "undefined" && notifyPrefEnabled(),
  );
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const toggleNotify = () => {
    if (notifyOn) {
      setNotifyPref(false);
      setNotifyOn(false);
      return;
    }
    if (notifyPerm === "default") {
      // Enable only once granted — an "on" toggle that can never fire is a lie.
      void Notification.requestPermission().then((p) => {
        setNotifyPerm(p);
        if (p === "granted") {
          setNotifyPref(true);
          setNotifyOn(true);
        }
      });
      return;
    }
    // "denied" still flips the preference on — the card's hint line says why
    // it stays silent, and un-blocking in the browser then just works.
    setNotifyPref(true);
    setNotifyOn(true);
  };

  // The socket + pub/sub live in session-bus.ts (H.9); one bus per mount.
  // useState's lazy initializer, NOT useMemo: Fast Refresh re-runs useMemo on
  // every hot edit (dependency lists are deliberately ignored), and each
  // re-run opened a fresh socket while the orphaned one stayed attached —
  // inflating the fleet's viewport count during dev (2026-07-25, Kyle).
  // State survives a hot update, so the one bus lives as long as the page.
  const [bus] = useState(createSessionBus);
  // Same lazy-useState idiom: one notifier (and one visibilitychange
  // listener) for the page's life. Null where the API doesn't exist.
  const [notifier] = useState(createDomNotifier);

  // ── File drag-and-drop (Phase FD) ───────────────────────────────────────
  // Shell chrome end to end: the drop overlay, the upload strip, and the
  // staged-path insertion are shell-owned; agent output can't reach any of
  // them. The pure core lives in file-drop.ts; the ref indirection lets the
  // once-created instance call the latest announce/draft closures.
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const attachDroppedPath = useRef<(path: string, name: string) => void>(() => {});
  const [fileDrop] = useState(() =>
    createFileDrop({
      uploadBegin: (name, size) => bus.uploadBegin(name, size),
      uploadChunk: (id, data) => bus.uploadChunk(id, data),
      uploadAbort: (id) => bus.uploadAbort(id),
      onChange: setUploads,
      onAttached: (path, name) => attachDroppedPath.current(path, name),
    }),
  );

  // Screen-reader announcements (A.1) — see Announcer.tsx for why the
  // transcript itself stays silent and these speak at turn boundaries.
  const { message: announcement, announce } = useAnnouncer();
  // Phase FD: a staged path lands in the prompt through the draft merge —
  // which never discards composed text — quoted the way a terminal drop
  // quotes, with a polite announcement naming what happened.
  attachDroppedPath.current = (path, name) => {
    promptDraftId.current += 1;
    setPromptDraft({ id: promptDraftId.current, text: quoteForPrompt(path) });
    announce(`Attached ${name} — its path was added to the prompt.`);
  };
  // The turn's prose, accumulated from text_delta so turn_end can announce
  // the response once, whole. A ref (not state): nothing renders from it, and
  // it must not re-run the subscription on every token.
  const turnText = useRef("");
  // Only announce connection TRANSITIONS — onConnection fires true on mount,
  // and "Reconnected" on page load is a lie.
  const wasConnected = useRef<boolean | null>(null);

  useEffect(
    () =>
      bus.subscribe((m) => {
        // Upload replies are per-viewport correlation traffic, not session
        // history — route them before the turn accounting ever sees them.
        if (fileDrop.handle(m as WireMsg)) return;
        // Replayed history must repaint state but never re-fire live-only
        // side effects: on every reload/reconnect the full-buffer replay
        // re-spoke each historical turn to screen readers, ending with an
        // old response presented as though it just arrived — the same lie
        // the wasConnected guard below blocks for "Reconnected"
        // (2026-07-29 bughunt).
        const live = !("replay" in m && m.replay);
        const openBefore = openTurns.current;
        openTurns.current = nextOpenTurns(openTurns.current, m.type, !live);
        traceTurn(m.type, !live, openBefore, openTurns.current, m.type === "user_prompt" ? m.text : undefined);
        if (m.type === "user_prompt") {
          setBusy(true);
          setActivity({ state: "thinking" });
          turnText.current = "";
          if (live) announce("Sent. Working…");
          // They've moved on in the new session — the R.4c notice is done.
          setNotices((n) => (n.session ? { ...n, session: false } : n));
        } else if (
          m.type === "status" ||
          m.type === "thinking_delta" ||
          m.type === "text_delta" ||
          m.type === "tool_use"
        ) {
          // Busy re-derives from ANY turn activity, not just the
          // user_prompt — a tail resume mid-turn replays none of the turn's
          // opening frames, and busy was cleared on the disconnect (R.4c).
          // The turn COUNTER re-derives with it (nextOpenTurns' floor rule,
          // 2026-07-29 bughunt — see turn-busy.ts).
          setBusy(true);
          // SA.2/SA.3: a SUBAGENT's traffic (parentId set) still proves the
          // turn is busy, but it is not the parent's voice — child prose and
          // child tool churn must not steer the activity label (the deck
          // shows each subagent's own current action; bughunt 2026-08-14 r2
          // aligned tool_use with the design after the server-side comment
          // claimed it and the client contradicted it), and child prose
          // never lands in the turn-end announcement. The announcer still
          // speaks child tools — the audible peer of the deck's ticker.
          const subagentTraffic =
            (m.type === "text_delta" || m.type === "thinking_delta" || m.type === "tool_use") &&
            m.parentId;
          if (m.type === "status") setActivity({ state: m.state, label: m.label });
          else if (m.type === "thinking_delta") {
            if (!subagentTraffic) setActivity({ state: "thinking" });
          } else if (m.type === "tool_use") {
            if (!subagentTraffic) setActivity({ state: "tool", label: m.name });
          }
          // Streamed prose means the last specific label is over; the
          // indicator falls back to the generic "working…".
          else if (!subagentTraffic) setActivity(null);
          // A.1: the response is announced once at turn_end, so the prose is
          // banked here rather than spoken per token.
          if (m.type === "text_delta" && !subagentTraffic) turnText.current += m.text;
          // Tool activity is the other thing a sighted user reads off the
          // transcript mid-turn; announce the name, not the arguments.
          if (m.type === "tool_use" && live) announce(`Running ${m.name}.`);
        } else if (m.type === "tool_result") {
          // A finished tool must not keep naming itself — a frozen "Bash"
          // through the next model round trip reads as "done?" (2026-07-29).
          // A CHILD's result is not the labeled tool finishing: subagent
          // traffic never steers the root label, in either direction
          // (bughunt 2026-08-14 r2).
          if (!m.parentId) setActivity((a) => (a?.state === "tool" ? null : a));
        } else if (m.type === "turn_end") {
          setBusy(openTurns.current > 0);
          setActivity(null);
          setAsks([]); // a request that outlived its turn is void (server denies)
          if (live) announce(turnResponse(turnText.current));
          turnText.current = "";
        } else if (m.type === "permission_request") {
          setAsks((a) => [
            ...a,
            { tool: m.tool, detail: m.detail, id: m.id, ...(m.parentId ? { parentId: m.parentId } : {}) },
          ]);
          // Assertive: this one blocks the turn until answered. A replayed
          // ask still paints the bar (it may be genuinely pending), just
          // without re-interrupting the reader.
          if (live)
            announce(
              `Permission needed${m.parentId ? " (subagent)" : ""}: ${m.tool}. ${m.detail}`,
              true,
            );
        } else if (m.type === "permission_resolved") {
          // The ask was answered on ANOTHER viewport, or auto-denied by the
          // daemon's timeout — drop it HERE too. Before this, the bar sat
          // until turn_end and a tap on it was a silent stale no-op at the
          // adapter (the phone-hangs bug, 2026-07-28). A locally-answered ask
          // is already gone (the click removed it), so the filter no-ops and
          // the announcement stays quiet.
          if (asksRef.current.some((a) => a.id === m.id)) {
            announce(m.allow ? "Permission allowed." : "Permission denied.");
          }
          setAsks((a) => a.filter((x) => x.id !== m.id));
        } else if (m.type === "agents") {
          setDaemonInfo({
            agents: m.agents,
            cwd: m.cwd,
            home: m.home,
            folderPicker: m.folderPicker,
            relay: m.relay,
            version: m.version,
            billing: m.billing,
          });
        } else if (m.type === "subscription") {
          setSubReply(m);
        } else if (m.type === "prompt_options") {
          setPromptOptions(m.options);
        } else if (m.type === "session_created") {
          setMeta({ sessionId: m.sessionId, cwd: m.cwd, agent: m.agent, model: m.model, demo: m.demo });
          setNotices((n) => ({
            ...n,
            onboarding: null,
            ...(m.fallback ? { session: true } : {}),
          }));
        } else if (m.type === "refused") {
          // No session — the relay refused this subscription-backed
          // attach. Show the reason (also surfaced at onboarding if we're there) (R.4i).
          setNotices((n) => ({ ...n, refused: m.message, onboarding: m.message }));
          announce(m.message, true);
        } else if (m.type === "error") {
          // An error ENDS the turn — the daemon says so (registry.ts flips the
          // session to idle on it), so the indicator must come down here too.
          // Without this the shell showed "working…" for the life of the
          // session after any errored turn, and a reload replayed the same
          // imbalance rather than clearing it (2026-07-30).
          setBusy(openTurns.current > 0);
          setActivity(null);
          // Only the onboarding card consumes this; in-session errors already
          // render in the output zone.
          setNotices((n) => ({ ...n, onboarding: m.message }));
          announce(m.message, true);
        } else if (m.type === "bang_start") {
          setBang((b) => ({ ...b, tail: "" }));
        } else if (m.type === "bang_output") {
          // Only the tail matters (prompt detection) — keep it tiny.
          setBang((b) => ({ ...b, tail: (b.tail + m.data).slice(-400) }));
        } else if (m.type === "bang_end") {
          setBang((b) => (b.my && b.my.id === m.id ? { ...b, my: null } : b));
        } else if (m.type === "usage") {
          // Tokens are per-turn → sum for the session total. Cost is already
          // the session-cumulative figure → take it as-is, never add (T2.6).
          // Reset-on-zone_reset keeps both replay-safe: re-summing tokens and
          // re-taking the final cost both land on the right number.
          setUsage((u) => ({
            model: m.model,
            turnIn: m.inputTokens,
            turnOut: m.outputTokens,
            sumIn: u.sumIn + m.inputTokens,
            sumOut: u.sumOut + m.outputTokens,
            cost: m.costUsd ?? u.cost,
          }));
        } else if (m.type === "zone_reset") {
          openTurns.current = 0;
          setBusy(false);
          setActivity(null);
          setAsks([]);
          setUsage(ZERO_USAGE);
          setPromptOptions([]);
          turnText.current = "";
        }
      }),
    [bus, announce],
  );

  useEffect(
    () =>
      bus.onConnection((c, refusal) => {
        setConnected(c);
        setConnNote(c ? undefined : refusal);
        // A.1: losing the socket is silent on screen except for a dot
        // changing colour — assertive, and only on a real transition.
        if (wasConnected.current !== null && wasConnected.current !== c) {
          if (c) announce("Reconnected.");
          else announce(refusal ?? "Disconnected — reconnecting.", true);
        }
        wasConnected.current = c;
        // A dropped socket can't be mid-turn from this viewport's point
        // of view — clear the working state and the ■ esc stop affordance so
        // a dead daemon doesn't look like an agent still thinking. Replay (or
        // the turn-activity frames above) re-derives busy after reconnect (R.4c).
        if (!c) {
          openTurns.current = 0;
          setBusy(false);
          setActivity(null);
        }
      }),
    [bus, announce],
  );

  // Esc interrupts from anywhere in the page, not just the textarea. Stable
  // identity — a fresh arrow each render would re-register the window
  // listener on every re-render of a streaming turn. An interrupt kills
  // everything in flight (a queued follow-up included) but doesn't promise
  // one turn_end per open turn — the mock emits a single turn_end for all
  // abandoned work — so the counter drops to the one turn_end still coming.
  const interrupt = useCallback(() => {
    openTurns.current = Math.min(openTurns.current, 1);
    bus.interrupt();
  }, [bus]);
  useEscapeKey(busy ? interrupt : undefined);

  // Stable identity: Onboarding keys its poll interval on this prop, so a
  // fresh arrow each render would restart the 3s timer instead of letting
  // it fire.
  const refreshAgents = useCallback(() => bus.refreshAgents(), [bus]);

  // Tab title + favicon status light (Step 4.2) — painter in tab-status.ts.
  useEffect(() => {
    paintTabStatus(asks.length > 0 ? "permission" : busy ? "busy" : "idle");
  }, [busy, asks.length]);

  // Needs-you notifications (NF.1): the same tri-state the tab light paints,
  // pushed through the notifier so a hidden viewport can toast. reset() on
  // any disconnect: the drop forces busy→false above, and that forced edge
  // must never read as a finished turn.
  useEffect(() => {
    if (!notifier) return;
    if (!connected || !meta.sessionId) {
      notifier.reset();
      return;
    }
    const ask = asks[0];
    notifier.update([
      {
        id: meta.sessionId,
        state: asks.length > 0 ? "permission" : busy ? "busy" : "idle",
        title: folderTitle(meta.cwd) ?? (meta.agent ? agentLabel(meta.agent) : "session"),
        agent: meta.agent ? agentLabel(meta.agent) : undefined,
        tool: ask?.tool,
        detail: ask?.detail,
      },
    ]);
  }, [notifier, connected, busy, asks, meta]);

  // Phase FD: window-level drag targets — anywhere on the page is the drop
  // zone (small targets punish drags), gated off onboarding (no session to
  // stage into). Depth-counted because dragenter/dragleave fire per element
  // crossed; only file drags participate (text selections drag too).
  useEffect(() => {
    if (!meta.sessionId) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragActive(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) fileDrop.start(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [meta.sessionId, fileDrop]);

  const answer = (id: string, allow: boolean) => {
    bus.answerPermission(id, allow);
    setAsks((a) => a.filter((x) => x.id !== id));
  };

  // A leading `!` is intercepted by the trusted shell and runs as a real
  // shell command (4.9); the finished transcript then reaches the agent as
  // its own turn, exactly as the terminal harness does.
  const send = (text: string) => {
    setReviewPromptVisible(false);
    const m = text.match(/^!\s*(.+)$/s);
    if (m) {
      const command = m[1].trim();
      setBang({ my: { id: bus.sendBang(command), command }, tail: "" });
    } else {
      bus.sendPrompt(text);
    }
  };

  // Onboarding shows until this viewport has a session — but not when the URL
  // already names one (that path attaches straight through).
  const showOnboarding = !hasUrlSession && !meta.sessionId;

  return (
    <div className={"shell" + (changesOpen && reviewPromptVisible ? " changes-draft-visible" : "")}>
      <Announcer message={announcement} />
      {showOnboarding && (
        <Onboarding
          agents={daemonInfo.agents}
          defaultCwd={tildify(daemonInfo.cwd, daemonInfo.home)}
          error={notices.onboarding}
          onCwdChange={() => setNotices((n) => ({ ...n, onboarding: null }))}
          onBrowse={daemonInfo.folderPicker ? bus.pickFolder : undefined}
          onPick={(agent, cwd, backend) => {
            setNotices((n) => ({ ...n, onboarding: null }));
            bus.createSession(agent, cwd, backend);
          }}
          onRefresh={refreshAgents}
        />
      )}
      <div className="behind-dialog" inert={showOnboarding || undefined}>
        {notices.session && (
          // SHELL-OWNED notice — honest about the swap the server made (R.4c).
          <NoticeLine
            text={
              "that session no longer exists — started a new one (it was ended, removed, or predates durable recovery)"
            }
            onDismiss={() => setNotices((n) => ({ ...n, session: false }))}
          />
        )}
        {notices.refused && (
          // SHELL-OWNED — the relay refused a subscription-backed session (R.4i).
          <NoticeLine
            text={notices.refused}
            onDismiss={() => setNotices((n) => ({ ...n, refused: null }))}
          />
        )}
        {meta.demo && (
          // SHELL-OWNED banner — the agent paints nothing here, so a demo
          // session is unmistakably labeled and the label can't be faked or
          // cleared (same trust rule as the permission bar) (R.4b).
          <div className="demo-banner">
            <span className="demo-banner-badge">demo</span>
            <span className="demo-banner-text">
              scripted replies — no real agent is running
              {meta.agent && connectHint(meta.agent) && (
                <>
                  {" · to connect "}
                  {agentLabel(meta.agent)}: {connectHint(meta.agent)}, then restart Mirafold
                </>
              )}
            </span>
          </div>
        )}
        {/* The activity bar (VS Code convention) is the workbench's permanent
            left edge — it spans transcript, prompt box AND status bar,
            everything to its strict right; only banners run full-width. Its
            Files and Changes icons share one auxiliary workspace slot, which
            sits left of the transcript in a flex row so the transcript keeps
            rendering beside it; both closed = transcript full-width. */}
        <div className="main-row">
          <ActivityBar
            filesOpen={filesOpen}
            changesOpen={changesOpen}
            disabled={!meta.sessionId}
            onToggleFiles={() => toggleAuxiliary("files")}
            onToggleChanges={() => toggleAuxiliary("changes")}
          />
          <div className="main-col">
            <div className="zone-outer">
              <FilesPanel
                open={filesOpen && Boolean(meta.sessionId)}
                subscribe={bus.subscribe}
                requestListdir={bus.requestFsListdir}
                requestRead={bus.requestFsRead}
                requestDiff={bus.requestFsDiff}
                onClose={closeAuxiliary}
                onSwitch={switchAuxiliary}
                rootLabel={tildify(meta.cwd, daemonInfo.home)}
                sessionKey={meta.sessionId}
              />
              <ChangesPanel
                open={changesOpen && Boolean(meta.sessionId)}
                subscribe={bus.subscribe}
                requestChanges={bus.requestFsChanges}
                requestRead={bus.requestFsRead}
                requestDiff={bus.requestFsDiff}
                onClose={closeAuxiliary}
                onSwitch={switchAuxiliary}
                onCreateDraft={createReviewDraft}
                promptContainerRef={promptContainerRef}
                promptVisible={reviewPromptVisible}
                rootLabel={tildify(meta.cwd, daemonInfo.home)}
                sessionKey={meta.sessionId}
              />
              <RenderZone
                ref={inputNavigationRef}
                subscribe={bus.subscribe}
                sendAction={bus.sendAction}
                busy={busy}
                focusPrompt={focusPrompt}
                onInputNavigationChange={updateInputNavigationState}
              />
            </div>
            <ActivityLine busy={busy} label={activityLabel(activity)} />
            <PermBar asks={asks} onAnswer={answer} />
            {bang.my && (
              <BangBar
                command={bang.my.command}
                tail={bang.tail}
                onInput={(data) => bus.sendBangInput(bang.my!.id, data)}
                onKill={() => bus.killBang(bang.my!.id)}
              />
            )}
            {uploads.length > 0 && (
              <div className="drop-strip">
                {uploads.map((u) => (
                  <span
                    key={u.id}
                    className={"drop-chip" + (u.status === "error" ? " is-error" : "")}
                  >
                    {u.status === "uploading" ? `⇪ ${u.name}…` : `${u.name}: ${u.message}`}
                    {u.status === "error" && (
                      <button
                        className="drop-chip-dismiss"
                        onClick={() => fileDrop.dismiss(u.id)}
                        aria-label={`Dismiss the ${u.name} upload error`}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            <PromptBox
              onSend={send}
              busy={busy}
              onInterrupt={interrupt}
              cwd={tildify(meta.cwd, daemonInfo.home)}
              options={promptOptions}
              textareaRef={promptRef}
              containerRef={promptContainerRef}
              draft={promptDraft}
              globalTriggersDisabled={showOnboarding || settingsOpen}
              onNavigateLatestInput={navigateToLatestInput}
              inputNavigation={{
                // The disclosure occupies the space directly above the
                // prompt. Yield it to transient answer/input/upload strips;
                // navigation returns as soon as that higher-priority work is
                // gone.
                available: asks.length === 0 && !bang.my && uploads.length === 0,
                open: phoneInputNavigationOpen,
                position: inputNavigationState.position,
                total: inputNavigationState.total,
                onOpen: openPhoneInputNavigation,
                onClose: closeInputNavigation,
                onMove: movePhoneInputNavigation,
              }}
            />
            <StatusBar
              connected={connected}
              connectionNote={connNote}
              agent={meta.agent}
              // The engine's live report (usage) wins once a turn has run; until
              // then, what the daemon knew at attach ("default" beats nothing).
              model={usage.model ?? meta.model}
              sessionId={meta.sessionId}
              cwd={meta.cwd}
              usage={usage}
              mode={mode}
              onToggleTheme={() => setMode((m) => (m === "dark" ? "light" : "dark"))}
              onOpenSettings={() => setSettingsOpen(true)}
              onEndSession={meta.sessionId ? bus.endSession : undefined}
              relay={daemonInfo.relay}
              version={daemonInfo.version}
              billing={daemonInfo.billing === "license-key"}
              subRequest={bus.requestSubscription}
              subReply={subReply}
              workspaceOpen={auxiliary !== null}
              workspaceDisabled={!meta.sessionId}
              onToggleWorkspace={toggleWorkspace}
            />
          </div>
        </div>
        {dragActive && (
          <div className="drop-overlay" aria-hidden="true">
            <div className="drop-overlay-card">Drop files — their paths go to the prompt</div>
          </div>
        )}
        {settingsOpen && (
          <ThemePicker
            slots={slots}
            onPick={pickTheme}
            onClose={() => setSettingsOpen(false)}
            notify={
              notifyPerm === "unsupported"
                ? undefined
                : {
                    enabled: notifyOn,
                    blocked: notifyPerm === "denied",
                    onToggle: toggleNotify,
                  }
            }
            // The card's Session section (R.4l) — on phone this is THE place
            // these facts live (the bar carries only the agent name; the
            // prompt crumb is desktop-only), so it gets everything.
            session={{
              agent: meta.agent,
              model: usage.model ?? meta.model,
              cwd: tildify(meta.cwd, daemonInfo.home),
              sessionId: meta.sessionId,
              version: daemonInfo.version,
              usage:
                usage.sumIn + usage.sumOut > 0
                  ? { sum: usage.sumIn + usage.sumOut, cost: usage.cost }
                  : undefined,
            }}
          />
        )}
      </div>
    </div>
  );
}

/** A dismissible shell-owned notice line — one text span and the ✕. Shell's
 *  two banners (session swap, relay refusal) differ only in text and which
 *  dismiss setter fires. NOT FleetView's fleet-error variant, which has its
 *  own classes and role="alert". */
function NoticeLine({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div className="session-notice">
      <span className="session-notice-text">{text}</span>
      <button className="session-notice-dismiss" onClick={onDismiss} title="Dismiss">
        ✕
      </button>
    </div>
  );
}

/** The workbench's permanent left strip (VS Code's activity-bar convention):
 *  always present so the affordance never moves; its Files and Changes icons
 *  share one auxiliary workspace slot. Disabled until there's a session.
 *  DESKTOP ONLY (2026-07-25, Kyle): on ≤640px the strip is hidden — a
 *  permanent 46px rail is too much of a 390px screen — and both toggles live
 *  in the status bar instead. */
function ActivityBar({
  filesOpen,
  changesOpen,
  disabled,
  onToggleFiles,
  onToggleChanges,
}: {
  filesOpen: boolean;
  changesOpen: boolean;
  disabled: boolean;
  onToggleFiles: () => void;
  onToggleChanges: () => void;
}) {
  return (
    <div className="activity-bar">
      <button
        className={"ab-btn ab-files" + (filesOpen ? " is-active" : "")}
        onClick={onToggleFiles}
        disabled={disabled}
        title={filesOpen ? "Hide files" : "Show files"}
        aria-label="Files"
        aria-expanded={filesOpen}
      >
        <FilesGlyph />
      </button>
      <button
        className={"ab-btn ab-changes" + (changesOpen ? " is-active" : "")}
        onClick={onToggleChanges}
        disabled={disabled}
        title={changesOpen ? "Hide workspace changes" : "Show workspace changes"}
        aria-label="Workspace changes"
        aria-expanded={changesOpen}
      >
        <ChangesGlyph />
      </button>
    </div>
  );
}
