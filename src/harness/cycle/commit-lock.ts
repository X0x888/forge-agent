/**
 * While ULW is armed the driver owns `git commit`. Executor/Reviewer
 * commits reset nothing on the no-progress wall and skip review.
 * `FORGE_ULW_DRIVER_COMMIT=0` restores the old allow.
 */
import { isFalsy } from "../../util/bool.js";
import { cycleActive, loadActiveCycle } from "./state.js";

const GIT_COMMIT_RE = /\bgit(?:\s+(?:-C\s+\S+|--git-dir=\S+|--work-tree=\S+))*\s+commit\b/;

export function isGitCommitCommand(command: string): boolean {
  const c = String(command || "").replace(/\s+/g, " ").trim();
  if (!c) return false;
  if (/\bcommit-(?:tree|graph|pack)\b/.test(c)) return false;
  return c.split(/\s*(?:&&|;)\s*/).some((seg) => {
    const head = seg
      .replace(/^(?:[A-Za-z_][\w]*=\S*\s+)+/, "")
      .replace(/^(?:env|time|nice)\s+(?:-\S+\s+)*/, "");
    return /^git\b/.test(head) && GIT_COMMIT_RE.test(head);
  });
}

export function ulwGitCommitDenied(sessionId: string | undefined): string | null {
  if (isFalsy(process.env.FORGE_ULW_DRIVER_COMMIT)) return null;
  if (!sessionId) return null;
  const s = loadActiveCycle(sessionId);
  if (!s || !cycleActive(s)) return null;
  if (!s.enabled) return null;
  return (
    "HARD DENY [ulw-commit]: the cycle driver owns git commit while ULW is armed. " +
    "Close with Plan complete.; the harness commits after a parseable review and a green gate. " +
    "FORGE_ULW_DRIVER_COMMIT=0 off."
  );
}
