import type { SessionMeta } from "@protocol";

/** A session that wants an answer: the stream-derived permission hold, OR a
 * still-pending ask surviving past it — with concurrent requests, answering
 * the first lets the stream move while the rest wait. */
export function wantsAnswer(session: SessionMeta): boolean {
  return session.status === "permission" || (session.permissions?.length ?? 0) > 0;
}

/** Stable creation order so eyes can park on a session; sessions awaiting
 * permission lead, longest-stalled first. `createdAt` is optional for an old
 * daemon, where the stable sort preserves wire order. */
export function cockpitOrder(sessions: readonly SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => {
    const aWantsAnswer = wantsAnswer(a);
    const bWantsAnswer = wantsAnswer(b);
    if (aWantsAnswer !== bWantsAnswer) return aWantsAnswer ? -1 : 1;
    return aWantsAnswer
      ? a.lastActivity - b.lastActivity
      : (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}
