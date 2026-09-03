import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentName, PromptOption } from "@protocol";
import { ActivityLine, activityLabel } from "./ActivityLine";
import { BangBar } from "./BangBar";
import { DiffPanelGlyph } from "./DiffPanelGlyph";
import { FolderTreeGlyph } from "./FolderTreeGlyph";
import { CockpitGlyph } from "./CockpitGlyph";
import { AgentPicker } from "./AgentPicker";
import { PromptBox, type PromptDraft } from "./PromptBox";
import { OutputZone } from "./OutputZone";
import { FolderTreePanel } from "./folder-tree/FolderTreePanel";
import { DiffPanel } from "./diff-panel/DiffPanel";
import { CockpitPanel } from "./CockpitPanel";
import type { WorkspaceSurface } from "./WorkspaceTabs";
import { StatusBar, type Usage } from "./StatusBar";
import { createSessionBus } from "../transport/session-bus";
import type { SubscriptionReply } from "../subscription-card";
import { IDLE_TURN, reduceTurn, type TurnInput } from "../transcript/turn-state";
import { traceTurn } from "../transcript/turn-trace";
import { NO_DAEMON_INFO, daemonInfoFrom, withEntitlement, type DaemonInfo } from "../transport/daemon-hello";
import { ThemePicker } from "./ThemePicker";
import { useThemeSlots } from "../hooks/use-theme-slots";
import { useNotifyPreference } from "../hooks/use-notify-preference";
import { useFileDropZone } from "../hooks/use-file-drop-zone";
import { tildify } from "../workspace/tildify";
import { agentLabel, connectHint } from "../agents-meta";
import { paintTabStatus } from "../tab-status";
import { createDomNotifier, folderTitle } from "../notify";
import { createFileDrop, quoteForPrompt, type UploadEntry } from "../workspace/file-drop";
import type { WireMsg } from "@protocol";
import { useEscapeKey } from "../hooks/use-escape";
import { Announcer, useAnnouncer } from "./Announcer";
import { PermissionBar } from "./PermissionBar";
import type { InputNavigationDirection } from "../input/input-navigation";
import { sessionIdFromPath } from "../transport/session-url";
import { cockpitPanelWasOpen, rememberCockpitPanel } from "../cockpit-panel-state";
import { useIsPhone } from "../hooks/use-is-phone";
import type {
  InputNavigationHandle,
  InputNavigationState,
} from "../input/use-input-navigation";

const ZERO_USAGE: Usage = { turnIn: 0, turnOut: 0, sumIn: 0, sumOut: 0, cost: 0 };
type AuxiliarySurface = WorkspaceSurface | "cockpit";

/**
 * The trusted shell. Owns the socket and the prompt box; neither is ever
 * re-rendered or touched by agent output. The agent only paints into
 * OutputZone via the message bus below.
 *
 * A connection is a viewport onto a registry session. The URL is
 * the session identity (/s/<id>) — refresh-safe and shareable across tabs.
 */
export function Shell() {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptContainerRef = useRef<HTMLDivElement>(null);
  // OutputZone owns transcript destinations; Shell bridges that controller to
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
  // Busy, the activity label, the pending asks, and the banked prose are
  // one state derived entirely from the wire by the pure reducer in
  // turn-state.ts. The ref is the synchronous source of truth for the bus
  // subscription (several frames can land before React re-renders); the
  // state mirror is what renders.
  const turnRef = useRef(IDLE_TURN);
  const [turn, setTurn] = useState(IDLE_TURN);
  const { busy, activity, asks } = turn;

  // ── The session + daemon (status-bar state — all shell-owned) ─────
  const [connected, setConnected] = useState(false);
  // A relay refusal reason while disconnected (no daemon / at capacity /
  // origin), surfaced in the status indicator; undefined = an ordinary drop.
  const [connNote, setConnNote] = useState<string | undefined>(undefined);
  const [meta, setMeta] = useState<{
    sessionId?: string;
    cwd?: string;
    shellCwd?: string;
    agent?: AgentName;
    model?: string;
    demo?: boolean;
  }>({});
  const [usage, setUsage] = useState<Usage>(ZERO_USAGE);
  // Provider-owned pre-submit catalog (`/` commands, Codex `$` skills).
  // Replaced whole whenever the adapter reports a changed catalog.
  const [promptOptions, setPromptOptions] = useState<PromptOption[]>([]);
  // Everything the daemon's `agents` hello carries, kept together: which
  // agents it offers (agent picker; a URL that already names a session
  // skips the picker), where it was launched (the default session cwd)
  // + home for ~-abbreviation, the pairing info for the "connect a device"
  // QR (local viewports only), and its build version.
  const [daemonInfo, setDaemonInfo] = useState<DaemonInfo>(NO_DAEMON_INFO);
  // The latest `subscription` reply — the pair card's manage view
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
    // Shown until dismissed.
    refused: string | null;
    // The last create error, so the agent picker card can show a rejected
    // working dir.
    agentPicker: string | null;
  }>({ session: false, refused: null, agentPicker: null });

  // ── The `!` command ───────────────────────────────────────────────
  const [bang, setBang] = useState<{
    // The bang THIS viewport issued, if still running — only the issuer gets
    // the stdin affordance (a sudo prompt must never fan out to a second tab
    // or, later, a phone via the relay). Lost on refresh: Tier 1.
    my: { id: string; command: string } | null;
    // Tail of the running command's output — drives the password-prompt
    // detection that masks the stdin field. One bang per session, so untagged.
    tail: string;
  }>({ my: null, tail: "" });
  // A bang_start is broadcast to every viewport, so only ids minted by this
  // viewport may claim its stdin/kill controls. Keep each id until the daemon
  // either accepts it with bang_start or rejects it with a private bang_end.
  const ownBangRequests = useRef(new Set<string>());

  const hasUrlSession = useMemo(() => sessionIdFromPath(location.pathname) !== null, []);

  // ── The auxiliary workspace ─────────────────────────────────────────────
  // Exactly one shell-owned side surface can be open: Cockpit moves between
  // sessions, Files answers what exists, and Changes answers what differs
  // from Git HEAD. Cockpit alone persists because its purpose is to follow a
  // direct session-to-session navigation; an explicit close or replacement
  // clears that preference.
  const [auxiliary, setAuxiliary] = useState<AuxiliarySurface | null>(() =>
    cockpitPanelWasOpen() ? "cockpit" : null,
  );
  const phone = useIsPhone();
  const cockpitOpen = auxiliary === "cockpit";
  const folderTreeOpen = auxiliary === "folder-tree";
  const diffPanelOpen = auxiliary === "diff-panel";
  const [reviewPromptVisible, setReviewPromptVisible] = useState(false);
  const fileOpenRequestId = useRef(0);
  const [fileOpenRequest, setFileOpenRequest] = useState<{ id: number; path: string } | null>(null);
  const [promptDraft, setPromptDraft] = useState<PromptDraft>();
  const promptDraftId = useRef(0);
  const createReviewDraft = useCallback((text: string) => {
    promptDraftId.current += 1;
    setPromptDraft({ id: promptDraftId.current, text });
    setReviewPromptVisible(true);
  }, []);
  const toggleAuxiliary = (surface: AuxiliarySurface) => {
    if (surface !== "diff-panel" || auxiliary !== "diff-panel") setReviewPromptVisible(false);
    setAuxiliary((current) => {
      const next = current === surface ? null : surface;
      rememberCockpitPanel(next === "cockpit");
      return next;
    });
  };
  const closeAuxiliary = () => {
    setAuxiliary(null);
    rememberCockpitPanel(false);
    setReviewPromptVisible(false);
  };
  // Phone: the status bar carries ONE workspace toggle,
  // not two side-by-side icons; it reopens whichever surface was used last
  // (Files until Changes has been chosen once), and the drawer's own head
  // switches between them. Cockpit stays a desktop rail surface.
  const lastSurface = useRef<WorkspaceSurface>("folder-tree");
  if (auxiliary === "folder-tree" || auxiliary === "diff-panel") lastSurface.current = auxiliary;
  const toggleWorkspace = () => toggleAuxiliary(lastSurface.current);
  const switchAuxiliary = (surface: WorkspaceSurface) => {
    if (auxiliary !== surface) toggleAuxiliary(surface);
  };
  const openTranscriptFile = useCallback((path: string) => {
    fileOpenRequestId.current += 1;
    setFileOpenRequest({ id: fileOpenRequestId.current, path });
    setReviewPromptVisible(false);
    setAuxiliary("folder-tree");
    rememberCockpitPanel(false);
  }, []);

  // ── The theme and the settings card ─────────────────────────────────────
  // Shell-owned UI state (use-theme-slots.ts); the pill itself is two
  // positions, mode in, mode out.
  const { mode, slots, pickTheme, toggleMode } = useThemeSlots();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Needs-you notifications: preference + browser grant (use-notify-preference.ts).
  const { notifyOn, notifyPerm, toggleNotify } = useNotifyPreference();

  // The socket + pub/sub live in session-bus.ts; one bus per mount.
  // useState's lazy initializer, NOT useMemo: Fast Refresh re-runs useMemo on
  // every hot edit (dependency lists are deliberately ignored), and each
  // re-run opened a fresh socket while the orphaned one stayed attached —
  // inflating the fleet's viewport count during dev.
  // State survives a hot update, so the one bus lives as long as the page.
  const [bus] = useState(createSessionBus);
  // Same lazy-useState idiom: one notifier (and one visibilitychange
  // listener) for the page's life. Null where the API doesn't exist.
  const [notifier] = useState(createDomNotifier);

  // ── File drag-and-drop ───────────────────────────────────────
  // Shell chrome end to end: the drop overlay, the upload strip, and the
  // staged-path insertion are shell-owned; agent output can't reach any of
  // them. The pure core lives in file-drop.ts; the ref indirection lets the
  // once-created instance call the latest announce/draft closures.
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
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

  // Screen-reader announcements — see Announcer.tsx for why the
  // transcript itself stays silent and these speak at turn boundaries.
  const { message: announcement, announce } = useAnnouncer();
  // Every turn transition goes through here: reduce, adopt, then speak the
  // announcements the reducer decided on.
  const applyTurn = useCallback(
    (input: TurnInput) => {
      const before = turnRef.current;
      const { state, announcements } = reduceTurn(before, input);
      turnRef.current = state;
      setTurn(state);
      for (const a of announcements) announce(a.text, a.assertive);
      return { before, state };
    },
    [announce],
  );
  // A staged path lands in the prompt through the draft merge —
  // which never discards composed text — quoted the way a terminal drop
  // quotes, with a polite announcement naming what happened.
  attachDroppedPath.current = (path, name) => {
    promptDraftId.current += 1;
    setPromptDraft({ id: promptDraftId.current, text: quoteForPrompt(path) });
    announce(`Attached ${name} — its path was added to the prompt.`);
  };
  // Only announce connection TRANSITIONS — onConnection fires true on mount,
  // and "Reconnected" on page load is a lie.
  const wasConnected = useRef<boolean | null>(null);

  useEffect(
    () =>
      bus.subscribe((m) => {
        // Upload replies are per-viewport correlation traffic, not session
        // history — route them before the turn accounting ever sees them.
        if (fileDrop.handle(m as WireMsg)) return;
        const live = !("replay" in m && m.replay);
        const { before, state } = applyTurn({ kind: "message", msg: m });
        traceTurn(m.type, !live, before.openTurns, state.openTurns, m.type === "user_prompt" ? m.text : undefined);
        if (m.type === "user_prompt") {
          // They've moved on in the new session — the fallback notice is done.
          setNotices((n) => (n.session ? { ...n, session: false } : n));
        } else if (m.type === "agents") {
          setDaemonInfo(daemonInfoFrom(m));
        } else if (m.type === "entitlement") {
          setDaemonInfo((d) => withEntitlement(d, m));
        } else if (m.type === "subscription") {
          setSubReply(m);
        } else if (m.type === "prompt_options") {
          setPromptOptions(m.options);
        } else if (m.type === "session_created") {
          setFileOpenRequest(null);
          setMeta({
            sessionId: m.sessionId,
            cwd: m.cwd,
            shellCwd: m.shellCwd ?? m.cwd,
            agent: m.agent,
            model: m.model,
            demo: m.demo,
          });
          setNotices((n) => ({
            ...n,
            agentPicker: null,
            ...(m.fallback ? { session: true } : {}),
          }));
        } else if (m.type === "shell_cwd") {
          setMeta((current) => ({ ...current, shellCwd: m.cwd }));
        } else if (m.type === "refused") {
          // No session — the relay refused this subscription-backed
          // attach. Show the reason (also surfaced in the agent picker if we're there).
          setNotices((n) => ({ ...n, refused: m.message, agentPicker: m.message }));
          announce(m.message, true);
        } else if (m.type === "error") {
          // Only the agent picker card consumes this; in-session errors already
          // render in the output zone (the turn reducer brought busy down).
          setNotices((n) => ({ ...n, agentPicker: m.message }));
        } else if (m.type === "bang_start") {
          const mine = ownBangRequests.current.delete(m.id);
          setBang((b) =>
            mine ? { my: { id: m.id, command: m.command }, tail: "" } : { ...b, tail: "" },
          );
        } else if (m.type === "bang_output") {
          // Only the tail matters (prompt detection) — keep it tiny.
          setBang((b) => ({ ...b, tail: (b.tail + m.data).slice(-400) }));
        } else if (m.type === "bang_end") {
          ownBangRequests.current.delete(m.id);
          setBang((b) => (b.my && b.my.id === m.id ? { ...b, my: null } : b));
        } else if (m.type === "usage") {
          // Tokens are per-turn → sum for the session total. Cost is already
          // the session-cumulative figure → take it as-is, never add.
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
          setUsage(ZERO_USAGE);
          setPromptOptions([]);
        }
      }),
    [bus, applyTurn],
  );

  useEffect(
    () =>
      bus.onConnection((c, refusal) => {
        setConnected(c);
        setConnNote(c ? undefined : refusal);
        // Losing the socket is silent on screen except for a dot
        // changing colour — assertive, and only on a real transition.
        if (wasConnected.current !== null && wasConnected.current !== c) {
          if (c) announce("Reconnected.");
          else announce(refusal ?? "Disconnected — reconnecting.", true);
        }
        wasConnected.current = c;
        // A dropped socket can't be mid-turn from this viewport's point
        // of view — clear the working state and the ■ esc stop affordance so
        // a dead daemon doesn't look like an agent still thinking. Replay (or
        // the turn-activity frames) re-derives busy after reconnect.
        if (!c) applyTurn({ kind: "disconnected" });
      }),
    [bus, announce, applyTurn],
  );

  // Esc interrupts from anywhere in the page, not just the textarea. Stable
  // identity — a fresh arrow each render would re-register the window
  // listener on every re-render of a streaming turn. An interrupt kills
  // everything in flight (a queued follow-up included) but doesn't promise
  // one turn_end per open turn — the mock emits a single turn_end for all
  // abandoned work — so the counter drops to the one turn_end still coming.
  const interrupt = useCallback(() => {
    applyTurn({ kind: "interrupt" });
    bus.interrupt();
  }, [bus, applyTurn]);
  useEscapeKey(busy ? interrupt : undefined);

  // Stable identity: AgentPicker keys its poll interval on this prop, so a
  // fresh arrow each render would restart the 3s timer instead of letting
  // it fire.
  const refreshAgents = useCallback(() => bus.refreshAgents(), [bus]);

  // Tab title + favicon status light — painter in tab-status.ts.
  useEffect(() => {
    paintTabStatus(asks.length > 0 ? "permission" : busy ? "busy" : "idle");
  }, [busy, asks.length]);

  // Needs-you notifications: the same tri-state the tab light paints,
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

  // The whole page is the drop zone while a session exists (use-file-drop-zone.ts).
  const onDroppedFiles = useCallback((files: File[]) => fileDrop.start(files), [fileDrop]);
  const dragActive = useFileDropZone(Boolean(meta.sessionId), onDroppedFiles);

  const answer = (id: string, allow: boolean) => {
    bus.answerPermission(id, allow);
    applyTurn({ kind: "answered", id });
  };

  // A leading `!` is intercepted by the trusted shell and runs as a real
  // shell command; the finished transcript then reaches the agent as
  // its own turn, exactly as the terminal harness does.
  const send = (text: string) => {
    setReviewPromptVisible(false);
    // `!!` is the silent form: same shell, same output, but the agent is
    // never told — the user is just using the terminal.
    const m = text.match(/^!(!?)\s*(.+)$/s);
    if (m) {
      const silent = m[1] === "!";
      const command = m[2].trim();
      const id = bus.sendBang(command, silent);
      ownBangRequests.current.add(id);
      // The daemon may reject this request because the previous PTY is still
      // running. Keep that PTY's stdin/kill controls until its own bang_end.
      setBang((current) =>
        current.my ? current : { my: { id, command }, tail: "" },
      );
    } else {
      bus.sendPrompt(text);
    }
  };

  // AgentPicker shows until this viewport has a session — but not when the URL
  // already names one (that path attaches straight through).
  const showAgentPicker = !hasUrlSession && !meta.sessionId;

  return (
    <div className={"shell" + (diffPanelOpen && reviewPromptVisible ? " diff-panel-draft-visible" : "")}>
      <Announcer message={announcement} />
      {showAgentPicker && (
        <AgentPicker
          agents={daemonInfo.agents}
          defaultCwd={tildify(daemonInfo.cwd, daemonInfo.home)}
          error={notices.agentPicker}
          onCwdChange={() => setNotices((n) => ({ ...n, agentPicker: null }))}
          onBrowse={daemonInfo.folderPicker ? bus.pickFolder : undefined}
          onPick={(agent, cwd, backend) => {
            setNotices((n) => ({ ...n, agentPicker: null }));
            bus.createSession(agent, cwd, backend);
          }}
          onRefresh={refreshAgents}
        />
      )}
      <div className="behind-dialog" inert={showAgentPicker || undefined}>
        {notices.session && (
          // SHELL-OWNED notice — honest about the swap the server made.
          <NoticeLine
            text={
              "that session no longer exists — started a new one (it was ended, removed, or predates durable recovery)"
            }
            onDismiss={() => setNotices((n) => ({ ...n, session: false }))}
          />
        )}
        {notices.refused && (
          // SHELL-OWNED — the relay refused a subscription-backed session.
          <NoticeLine
            text={notices.refused}
            onDismiss={() => setNotices((n) => ({ ...n, refused: null }))}
          />
        )}
        {meta.demo && (
          // SHELL-OWNED banner — the agent paints nothing here, so a demo
          // session is unmistakably labeled and the label can't be faked or
          // cleared (same trust rule as the permission bar).
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
            Cockpit, Files, and Changes icons share one auxiliary slot, which
            sits left of the transcript in a flex row so the transcript keeps
            rendering beside it; all closed = transcript full-width. */}
        <div className="main-row">
          <ActivityBar
            cockpitOpen={cockpitOpen}
            folderTreeOpen={folderTreeOpen}
            diffPanelOpen={diffPanelOpen}
            disabled={!meta.sessionId}
            onToggleCockpit={() => toggleAuxiliary("cockpit")}
            onToggleFolderTree={() => toggleAuxiliary("folder-tree")}
            onToggleDiffPanel={() => toggleAuxiliary("diff-panel")}
          />
          <div className="main-col">
            <div className="zone-outer">
              {!phone && cockpitOpen && meta.sessionId && (
                <CockpitPanel currentSessionId={meta.sessionId} />
              )}
              <FolderTreePanel
                open={folderTreeOpen && Boolean(meta.sessionId)}
                subscribe={bus.subscribe}
                requestListdir={bus.requestFsListdir}
                requestRead={bus.requestFsRead}
                requestDiff={bus.requestFsDiff}
                onClose={closeAuxiliary}
                onSwitch={switchAuxiliary}
                rootLabel={tildify(meta.cwd, daemonInfo.home)}
                sessionKey={meta.sessionId}
                fileOpenRequest={fileOpenRequest}
              />
              <DiffPanel
                open={diffPanelOpen && Boolean(meta.sessionId)}
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
              <OutputZone
                ref={inputNavigationRef}
                subscribe={bus.subscribe}
                sendAction={bus.sendAction}
                busy={busy}
                focusPrompt={focusPrompt}
                workspaceRoot={meta.cwd}
                sessionKey={meta.sessionId}
                onOpenWorkspaceFile={openTranscriptFile}
                onInputNavigationChange={updateInputNavigationState}
              />
            </div>
            <ActivityLine busy={busy} label={activityLabel(activity)} />
            <PermissionBar asks={asks} onAnswer={answer} />
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
              cwd={tildify(meta.shellCwd ?? meta.cwd, daemonInfo.home)}
              options={promptOptions}
              textareaRef={promptRef}
              containerRef={promptContainerRef}
              draft={promptDraft}
              globalTriggersDisabled={showAgentPicker || settingsOpen}
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
              onToggleTheme={toggleMode}
              onOpenSettings={() => setSettingsOpen(true)}
              onEndSession={meta.sessionId ? bus.endSession : undefined}
              relay={daemonInfo.relay}
              relayOff={daemonInfo.relayOff}
              entitlement={daemonInfo.entitlement}
              version={daemonInfo.version}
              billing={daemonInfo.billing === "license-key"}
              subRequest={bus.requestSubscription}
              subReply={subReply}
              workspaceOpen={folderTreeOpen || diffPanelOpen}
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
            // The card's Session section — on phone this is THE place
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
 *  always present so the affordance never moves; Cockpit, Files, and Changes
 *  share one auxiliary slot. Disabled until there's a session.
 *  DESKTOP ONLY: on ≤640px the strip is hidden — a
 *  permanent 46px rail is too much of a 390px screen — and one Files/Changes
 *  workspace toggle lives in the status bar instead. */
function ActivityBar({
  cockpitOpen,
  folderTreeOpen,
  diffPanelOpen,
  disabled,
  onToggleCockpit,
  onToggleFolderTree,
  onToggleDiffPanel,
}: {
  cockpitOpen: boolean;
  folderTreeOpen: boolean;
  diffPanelOpen: boolean;
  disabled: boolean;
  onToggleCockpit: () => void;
  onToggleFolderTree: () => void;
  onToggleDiffPanel: () => void;
}) {
  return (
    <div className="activity-bar">
      <button
        className={"ab-btn ab-cockpit" + (cockpitOpen ? " is-active" : "")}
        onClick={onToggleCockpit}
        disabled={disabled}
        title={cockpitOpen ? "Hide cockpit" : "Show cockpit"}
        aria-label="Cockpit"
        aria-expanded={cockpitOpen}
      >
        <CockpitGlyph />
      </button>
      <button
        className={"ab-btn ab-folder-tree" + (folderTreeOpen ? " is-active" : "")}
        onClick={onToggleFolderTree}
        disabled={disabled}
        title={folderTreeOpen ? "Hide files" : "Show files"}
        aria-label="Files"
        aria-expanded={folderTreeOpen}
      >
        <FolderTreeGlyph />
      </button>
      <button
        className={"ab-btn ab-diff-panel" + (diffPanelOpen ? " is-active" : "")}
        onClick={onToggleDiffPanel}
        disabled={disabled}
        title={diffPanelOpen ? "Hide workspace changes" : "Show workspace changes"}
        aria-label="Workspace changes"
        aria-expanded={diffPanelOpen}
      >
        <DiffPanelGlyph />
      </button>
    </div>
  );
}
