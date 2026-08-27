/**
 * On mill / contract hold: omit mill edit-class results from the suffix.
 * Never invent a first clip — that would reshape the cache prefix.
 */
import type { SessionData } from "./session.js";
import { normalizeRequestPruneSticky } from "./request-prune.js";
import { collectRecentMillToolIds } from "./mill-omit.js";

export {
  collectRecentMillToolIds,
  collectJobKeepToolIds,
  isMillEditClass,
  isJobKeepToolCall,
  isPlayLookToolCall,
  extractToolPaths,
  isMillPath,
} from "./mill-omit.js";
export { isMillEditClass as isMillToolCall } from "./mill-omit.js";

/** Merge recent mill tool ids into sticky omit *or* a suffix-only hold set. */
export function applyMillHoldPrune(
  session: SessionData,
  jobKeepPaths?: string[],
): number {
  const extra = collectRecentMillToolIds(session.messages, 48, jobKeepPaths);
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
  const have = new Set(session.meta.holdOmitToolIds ?? []);
  const add = extra.filter((id) => !have.has(id));
  if (!add.length) return 0;
  session.meta.holdOmitToolIds = [...have, ...add].slice(-48);
  return add.length;
}
