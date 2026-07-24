/**
 * Mid-run user control notices.
 *
 * Slash commands like /cycle 0 update harness state on disk immediately
 * (stop-guard reloads it). Notices additionally inject a short user message
 * before the *next* LLM call so the agent sees the flip without aborting.
 */

const noticesBySession = new Map<string, string[]>();

export function pushLiveNotice(sessionId: string, message: string): void {
  const text = message.trim();
  if (!sessionId || !text) return;
  const list = noticesBySession.get(sessionId) ?? [];
  list.push(text);
  noticesBySession.set(sessionId, list);
}

/** Drain pending notices (FIFO). Empty when none. */
export function drainLiveNotices(sessionId: string): string[] {
  const list = noticesBySession.get(sessionId);
  if (!list?.length) return [];
  noticesBySession.delete(sessionId);
  return list;
}

export function peekLiveNotices(sessionId: string): readonly string[] {
  return noticesBySession.get(sessionId) ?? [];
}

/** Test helper */
export function clearLiveNotices(sessionId?: string): void {
  if (sessionId) noticesBySession.delete(sessionId);
  else noticesBySession.clear();
}

export function formatLiveNoticesMessage(notices: string[]): string {
  if (notices.length === 1) {
    return `[User control — mid-run]\n${notices[0]}`;
  }
  return [
    `[User control — mid-run]`,
    ...notices.map((n, i) => `${i + 1}. ${n}`),
  ].join("\n");
}
