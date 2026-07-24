/**
 * Mid-turn free-text interjections (Grok Build–inspired).
 *
 * While the agent is working, the user can type free text (not only slash
 * controls). Text message is queued and drained at the next safe provider-turn
 * boundary, framed so the model can weigh it against in-flight work without a
 * forced deferral instruction.
 */

/** Match Grok shell large-prompt truncation. */
export const LARGE_INTERJECTION_THRESHOLD = 25_000;

const queueBySession = new Map<string, string[]>();

/** Wrap a user message in the canonical `<user_query>` envelope. */
export function formatUserQuery(userMessage: string): string {
  return `<user_query>\n${userMessage}\n</user_query>`;
}

/**
 * Wrap interjection text as a synthetic user message with a mid-turn note.
 * No "drop everything" instruction — the model decides how to weigh it.
 */
export function formatInterjection(text: string): string {
  const truncated = truncateUtf8(text, LARGE_INTERJECTION_THRESHOLD);
  return `The user sent a message while you were working:\n${formatUserQuery(truncated)}`;
}

/** Truncate at a UTF-8 character boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = 0;
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > maxBytes) break;
    bytes += n;
    end += ch.length;
  }
  return `${text.slice(0, end)}... [truncated]`;
}

export function pushInterjection(sessionId: string, message: string): void {
  const text = message.trim();
  if (!sessionId || !text) return;
  const list = queueBySession.get(sessionId) ?? [];
  list.push(text);
  queueBySession.set(sessionId, list);
}

/** Drain pending free-text interjections (FIFO). */
export function drainInterjections(sessionId: string): string[] {
  const list = queueBySession.get(sessionId);
  if (!list?.length) return [];
  queueBySession.delete(sessionId);
  return list;
}

export function peekInterjections(sessionId: string): readonly string[] {
  return queueBySession.get(sessionId) ?? [];
}

/** Test helper */
export function clearInterjections(sessionId?: string): void {
  if (sessionId) queueBySession.delete(sessionId);
  else queueBySession.clear();
}

/**
 * Format one or more drained interjections for injection into the transcript.
 * Multiple free-text messages in one drain are combined under one framing.
 */
export function formatInterjectionsMessage(texts: string[]): string {
  if (texts.length === 0) return "";
  if (texts.length === 1) return formatInterjection(texts[0]);
  const body = texts.map((t, i) => `(${i + 1}) ${t}`).join("\n");
  return formatInterjection(body);
}
