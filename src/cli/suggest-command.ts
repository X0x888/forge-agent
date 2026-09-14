/**
 * Bare `forge <token>` typo recovery — not a prefix-of-English matcher.
 * `helpp` → help; `hello` is a task.
 */
import { editDistance } from "../util/string-distance.js";
import { TOP_LEVEL_COMMANDS } from "./help-groups.js";

type TopLevel = (typeof TOP_LEVEL_COMMANDS)[number];

/** Common abbreviations / near-misses experts type as bare `forge <token>`. */
export const TOP_LEVEL_ALIASES: Record<string, TopLevel> = {
  cfg: "config",
  conf: "config",
  log: "logs",
  model: "models",
  session: "sessions",
  sess: "sessions",
  complete: "completion",
  whatsnew: "news",
  hud: "status",
  whoami: "auth",
  account: "accounts",
  diagnose: "doctor",
  tip: "tips",
  cheatsheet: "tips",
};

/**
 * When a bare prompt is a single token that looks like a mistyped subcommand,
 * return the closest command name (else null). Avoids false positives on short
 * real prompts ("hi", "ok", "fix") and English one-word tasks ("hello").
 */
export function suggestTopLevelCommand(prompt: string): string | null {
  const t = prompt.trim();
  if (!t || /\s/.test(t)) return null;
  // flags / paths / urls are not command typos
  if (t.startsWith("-") || t.includes("/") || t.includes(":") || t.includes(".")) {
    return null;
  }
  const q = t.toLowerCase();
  if ((TOP_LEVEL_COMMANDS as readonly string[]).includes(q)) return null;
  const aliased = TOP_LEVEL_ALIASES[q];
  if (aliased) return aliased;
  if (q.length < 4) return null;

  let best: { name: string; score: number } | null = null;
  for (const name of TOP_LEVEL_COMMANDS) {
    let score = 0;
    // Typed a prefix of a command (`sessi` → sessions). Do not treat a
    // command as a prefix of English (`hello` starts with `help`).
    if (name.startsWith(q)) score = 80;
    else {
      const d = editDistance(q, name);
      // Length ≤5: at most one edit so `helpp` recovers and `hello` does not.
      const maxD = q.length <= 5 ? 1 : q.length <= 9 ? 3 : 4;
      if (d > maxD) continue;
      // Require shared 3-char prefix so "next" does not match "news".
      if (q.length >= 3 && name.length >= 3 && q.slice(0, 3) !== name.slice(0, 3)) {
        continue;
      }
      score = 40 - d;
      if (name.length === q.length) score += 3;
      if (name[0] === q[0]) score += 2;
    }
    if (!best || score > best.score) best = { name, score };
  }
  if (!best || best.score < 38) return null;
  return best.name;
}
