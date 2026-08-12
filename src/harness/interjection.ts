/**
 * Mid-turn free-text interjections (Grok Build–inspired).
 *
 * While the agent is working, the user can type free text (not only slash
 * controls). Text is queued and drained at the next safe provider-turn
 * boundary, framed so the model can weigh it against in-flight work without a
 * forced deferral instruction.
 *
 * When ULW/goal/todos are active, a short harness context line is appended so
 * free-text steering does not silently drop the mandate (expert friction:
 * "I said X mid-run and it forgot the goal").
 */

import { looksLikeAdvisoryUserMessage } from "../util/advisory-intent.js";

/** Match Grok shell large-prompt truncation. */
export const LARGE_INTERJECTION_THRESHOLD = 25_000;

const queueBySession = new Map<string, string[]>();

/** Optional harness context attached when draining mid-run free-text. */
export interface InterjectionContext {
  /** e.g. "ULW cycle=1 wave=3 (CONTINUE)" */
  ulwLine?: string;
  /** Active goal objective (truncated). */
  goalLine?: string;
  openTodos?: number;
  /** Permission mode when not default (e.g. plan). */
  permissionMode?: string;
}

/** Wrap a user message in the canonical `<user_query>` envelope. */
export function formatUserQuery(userMessage: string): string {
  return `<user_query>\n${userMessage}\n</user_query>`;
}

/**
 * Build a one-line harness reminder for mid-run free-text.
 * Empty when nothing is armed.
 */
export function formatInterjectionContext(
  ctx?: InterjectionContext | null,
): string {
  if (!ctx) return "";
  const bits: string[] = [];
  if (ctx.ulwLine) bits.push(ctx.ulwLine);
  if (ctx.goalLine) bits.push(`goal: ${ctx.goalLine}`);
  if (typeof ctx.openTodos === "number" && ctx.openTodos > 0) {
    bits.push(`todos:${ctx.openTodos}`);
  }
  if (ctx.permissionMode && ctx.permissionMode !== "default") {
    bits.push(`mode:${ctx.permissionMode}`);
  }
  if (bits.length === 0) return "";
  return `[Forge harness still active: ${bits.join(" · ")}] Weigh the user message against this — do not abandon a half-finished safe step without reason, but do not ignore the interjection.`;
}

/**
 * Wrap interjection text as a synthetic user message with a mid-turn note.
 * No "drop everything" instruction — the model decides how to weigh it.
 */
export function formatInterjection(
  text: string,
  ctx?: InterjectionContext | null,
): string {
  const truncated = truncateUtf8(text, LARGE_INTERJECTION_THRESHOLD);
  // System/harness notifications (bg task complete, etc.) — no user_query envelope
  if (truncated.trimStart().startsWith("[Forge harness —")) {
    const harness = formatInterjectionContext(ctx);
    return harness ? `${truncated.trim()}\n${harness}` : truncated.trim();
  }
  const harness = formatInterjectionContext(ctx);
  const parts = [
    "The user sent a message while you were working:",
    formatUserQuery(truncated),
  ];
  if (harness) parts.push(harness);
  // Under ULW/goal, pure Q&A mid-run must not be read as a new work order
  // (oh-my-claude compact-intent lesson applied to live interjections).
  if (
    (ctx?.ulwLine || ctx?.goalLine) &&
    looksLikeAdvisoryUserMessage(truncated)
  ) {
    parts.push(
      "[Forge intent: ADVISORY/Q&A] Answer the question first. Do not start new implementation, commits, or scope expansion unless the user explicitly asks. Finish or safely park the half-finished step, then answer.",
    );
  }
  return parts.join("\n");
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
export function formatInterjectionsMessage(
  texts: string[],
  ctx?: InterjectionContext | null,
): string {
  if (texts.length === 0) return "";
  if (texts.length === 1) return formatInterjection(texts[0]!, ctx);
  const body = texts.map((t, i) => `(${i + 1}) ${t}`).join("\n");
  return formatInterjection(body, ctx);
}
