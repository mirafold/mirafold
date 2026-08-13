// Needs-you notifications (Phase NF): OS toasts when a session needs the
// user — a permission prompt appeared, or a turn finished — fired only from
// a tab the user can't see. The design rules live in the pure reducer here
// so Tier-1 can prove them without a DOM:
//   - fire only while hidden; gaining visibility closes everything this tab
//     created (the page itself is now the notification);
//   - one toast per session (`tag` = session id), newer events replace older;
//   - a toast whose cause resolves elsewhere (answered on another device,
//     prompted from the terminal) closes the moment the state moves on;
//   - losing visibility re-toasts any still-pending permission — the race
//     where the ask lands just as the user switches away is exactly the
//     failure this feature exists to close.
// Titles and bodies are shell-composed; engine-derived strings (tool,
// permission detail) ride along as inert plain text into an OS surface that
// never interprets markup (the trusted-shell rule).

export type NotifyState = "idle" | "busy" | "permission";

export type SessionSnapshot = {
  id: string;
  state: NotifyState;
  /** Shell-composed display name (session name / folder basename). */
  title: string;
  agent?: string;
  /** The blocking ask, when state is "permission" — inert engine text. */
  tool?: string;
  detail?: string;
};

export type NotifyFlags = {
  enabled: boolean;
  granted: boolean;
  visible: boolean;
};

export type ShowAction = {
  kind: "show";
  id: string;
  event: "permission" | "turn-end";
  title: string;
  body: string;
};
export type CloseAction = { kind: "close"; id: string };
export type NotifyAction = ShowAction | CloseAction;

// OS toast bodies clip anyway; capping here keeps a multi-line heredoc from
// turning the notification center into a scrollback.
const DETAIL_CAP = 160;
const cap = (s: string) =>
  s.length > DETAIL_CAP ? s.slice(0, DETAIL_CAP - 1) + "…" : s;

/** Last path segment — the session word a toast title leads with. */
export function folderTitle(cwd?: string): string | undefined {
  return cwd?.split(/[/\\]/).filter(Boolean).pop();
}

export function permissionToast(s: SessionSnapshot): ShowAction {
  const who = s.agent ?? "The agent";
  const body = s.tool
    ? s.detail
      ? cap(`${who} wants ${s.tool}: ${s.detail}`)
      : `${who} wants ${s.tool}.`
    : `${who} is waiting on a permission.`;
  return {
    kind: "show",
    id: s.id,
    event: "permission",
    title: `⚠ permission — ${s.title}`,
    body,
  };
}

export function turnEndToast(s: SessionSnapshot): ShowAction {
  return {
    kind: "show",
    id: s.id,
    event: "turn-end",
    title: `✓ turn finished — ${s.title}`,
    body: `${s.agent ?? "The agent"} is waiting for your next prompt.`,
  };
}

/**
 * The transition reducer. A session first seen mid-flight counts as coming
 * from "idle": first sight of a pending permission toasts (a background tab
 * discovering a stalled session is the feature working), while first sight
 * of "busy" or "idle" stays silent — there's no evidence a turn just ended.
 */
export function decideNotifications(
  prev: ReadonlyMap<string, NotifyState>,
  next: SessionSnapshot[],
  flags: NotifyFlags,
): { actions: NotifyAction[]; states: Map<string, NotifyState> } {
  const states = new Map(next.map((s) => [s.id, s.state] as const));
  const actions: NotifyAction[] = [];
  if (!flags.enabled || !flags.granted) return { actions, states };

  for (const id of prev.keys())
    if (!states.has(id)) actions.push({ kind: "close", id });

  for (const s of next) {
    const was = prev.get(s.id);
    if (was === s.state) continue;
    if (s.state === "permission") {
      if (!flags.visible) actions.push(permissionToast(s));
    } else if (was === undefined) {
      continue; // first sight of busy/idle: no evidence a turn just ended
    } else if (s.state === "idle") {
      // busy→idle AND permission→idle both end a turn the user isn't
      // watching; the turn-end toast replaces any permission toast (same tag).
      if (!flags.visible) actions.push(turnEndToast(s));
      else actions.push({ kind: "close", id: s.id });
    } else {
      // →busy: the cause resolved elsewhere (ask answered, new prompt sent).
      actions.push({ kind: "close", id: s.id });
    }
  }
  return { actions, states };
}

/** The subset of a Notification the binder drives — injectable for Tier-1. */
export type NotificationHandle = {
  close(): void;
  onclick: (() => void) | null;
};

export type NotifierDeps = {
  enabled(): boolean;
  granted(): boolean;
  visible(): boolean;
  spawn(opts: {
    tag: string;
    title: string;
    body: string;
  }): NotificationHandle | null;
  focus(): void;
};

export type Notifier = {
  /** Fresh session snapshots — diffs against the last call and acts. */
  update(next: SessionSnapshot[]): void;
  /**
   * Reseed without emitting, closing any open toast. Used across socket
   * drop/reconnect: a dropped socket forces busy→false in the viewport, and
   * without the reseed that forced edge would toast a turn-end no turn earned.
   */
  reset(next?: SessionSnapshot[]): void;
  /** Call on every document visibilitychange. */
  visibilityChanged(): void;
};

export function createNotifier(deps: NotifierDeps): Notifier {
  let states = new Map<string, NotifyState>();
  let last: SessionSnapshot[] = [];
  const open = new Map<string, NotificationHandle>();

  const close = (id: string) => {
    open.get(id)?.close();
    open.delete(id);
  };
  const show = (a: ShowAction) => {
    // The OS replaces same-tag toasts, but only our own handle can be
    // close()d later — so retire the old handle explicitly.
    close(a.id);
    const h = deps.spawn({ tag: `mirafold-${a.id}`, title: a.title, body: a.body });
    if (!h) return;
    h.onclick = () => {
      deps.focus();
      close(a.id);
    };
    open.set(a.id, h);
  };

  return {
    update(next) {
      last = next;
      const { actions, states: s } = decideNotifications(states, next, {
        enabled: deps.enabled(),
        granted: deps.granted(),
        visible: deps.visible(),
      });
      states = s;
      for (const a of actions) a.kind === "show" ? show(a) : close(a.id);
    },
    reset(next = []) {
      last = next;
      states = new Map(next.map((s) => [s.id, s.state] as const));
      for (const id of [...open.keys()]) close(id);
    },
    visibilityChanged() {
      if (deps.visible()) {
        for (const id of [...open.keys()]) close(id);
        return;
      }
      if (!deps.enabled() || !deps.granted()) return;
      for (const s of last) if (s.state === "permission") show(permissionToast(s));
    },
  };
}

// ---- browser wiring ----

export const NOTIFY_STORAGE_KEY = "mirafold-notify";

export const notifyPrefEnabled = (): boolean =>
  localStorage.getItem(NOTIFY_STORAGE_KEY) === "1";

export const setNotifyPref = (on: boolean): void => {
  if (on) localStorage.setItem(NOTIFY_STORAGE_KEY, "1");
  else localStorage.removeItem(NOTIFY_STORAGE_KEY);
};

/**
 * The real-DOM notifier: preference read live from localStorage (so a fleet
 * tab honors a toggle flipped in a session tab), OS grant read live (it can
 * be revoked any time). Returns null where the Notification API doesn't
 * exist (iOS Safari outside an installed PWA) — callers skip wiring.
 */
export function createDomNotifier(): Notifier | null {
  if (typeof Notification === "undefined") return null;
  const notifier = createNotifier({
    enabled: notifyPrefEnabled,
    granted: () => Notification.permission === "granted",
    visible: () => document.visibilityState === "visible",
    spawn: (o) => {
      // `new Notification` throws on platforms that only allow
      // ServiceWorkerRegistration.showNotification (Android Chrome) — treat
      // as unsupported rather than crashing the update path.
      try {
        const n = new Notification(o.title, { body: o.body, tag: o.tag, icon: "/favicon-32x32.png" });
        const h: NotificationHandle = { close: () => n.close(), onclick: null };
        n.onclick = () => h.onclick?.();
        return h;
      } catch {
        return null;
      }
    },
    focus: () => window.focus(),
  });
  document.addEventListener("visibilitychange", () => notifier.visibilityChanged());
  return notifier;
}
