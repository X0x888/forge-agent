/**
 * On mill / contract hold: omit recent mill tool results from the *suffix*
 * so the next completion is not a 90-token replay. Never invent a first
 * clip — that would reshape the cache prefix.
 */
import type { ChatMessage, ToolCall } from "../providers/types.js";
import type { SessionData } from "./session.js";
import { normalizeRequestPruneSticky } from "./request-prune.js";

const MILL_TOOL_RE = /write_file|search_replace|^edit$|apply_patch/i;
/** Maze systems/* stays as a fixture; numbered foo-n.js is the general mill. */
const MILL_PATH_RE =
  /CHANGELOG|tests\/w\d+|systems\/[\w-]*(share|overflow|taste|hush|kindle|groove)|[\w./-]*[-_.](?:v|w)?\d+\.(?:js|ts|mjs|cjs|jsx|tsx|py)\b/i;

export function isMillToolCall(tc: ToolCall | undefined): boolean {
  if (!tc?.function) return false;
  if (!MILL_TOOL_RE.test(tc.function.name || "")) return false;
  return MILL_PATH_RE.test(tc.function.arguments || "");
}

export function collectRecentMillToolIds(
  messages: ChatMessage[],
  limit = 48,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | undefined) => {
    const t = (id || "").trim();
    if (!t || seen.has(t) || ids.length >= limit) return;
    seen.add(t);
    ids.push(t);
  };
  for (let i = messages.length - 1; i >= 0 && ids.length < limit; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (isMillToolCall(tc)) push(tc.id);
      }
    }
  }
  return ids;
}

/** Merge recent mill tool ids into sticky omit *or* a suffix-only hold set. */
export function applyMillHoldPrune(session: SessionData): number {
  const extra = collectRecentMillToolIds(session.messages, 48);
  if (!extra.length) return 0;
  const frozen = normalizeRequestPruneSticky(session.meta.requestPruneSticky);
  if (frozen) {
    const have = new Set(frozen.omitted);
    const add = extra.filter((id) => !have.has(id));
    if (add.length) {
      session.meta.requestPruneSticky = {
        ...frozen,
        omitted: [...frozen.omitted, ...add],
      };
    }
    return add.length;
  }
  // No first clip yet — omit suffix mill bodies only. Do not create sticky.
  const have = new Set(session.meta.holdOmitToolIds ?? []);
  const add = extra.filter((id) => !have.has(id));
  if (!add.length) return 0;
  session.meta.holdOmitToolIds = [...have, ...add].slice(-48);
  return add.length;
}
