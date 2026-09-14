/**
 * Recover unknown --flag typos from a stable expert allowlist.
 * Hygiene `--dry` is not `--deny` (commander's edit-distance on the global
 * permission flag); preview lives on tmp prune and sessions prune --journals.
 */
import { suggestName } from "../util/suggest.js";

/** Drop commander `(Did you mean --deny?)` when the unknown flag is `--dry`. */
export function sanitizeUnknownDryHint(str: string): string {
  if (!/unknown option ['"]--dry(?:-run)?['"]/i.test(str)) return str;
  return str.replace(/\n\(Did you mean [^)]*\)/g, "");
}

export function unknownOptionHint(message: string): {
  suggestion?: string;
  hint?: string;
} {
  const m = message.match(/unknown option ['"]?(-{1,2}[\w-]+)/i);
  if (!m) return {};
  const raw = m[1] || "";
  if (/^--?dry(-run)?$/i.test(raw)) {
    return {
      hint: "Hygiene preview: forge tmp prune --dry  ·  forge sessions prune --journals --dry",
    };
  }
  const candidates = [
    "--json",
    "--session",
    "--continue",
    "--new",
    "--title",
    "--cwd",
    "--provider",
    "--model",
    "--effort",
    "--permission-mode",
    "--sandbox",
    "--sandbox-network",
    "--sandbox-missing",
    "--read-outside",
    "--max-turns",
    "--max-cycles",
    "--max-waves",
    "--base-url",
    "--api-key",
    "--ulw",
    "--goal",
    "--force",
    "--help",
    "--version",
  ];
  const tip = suggestName(raw.replace(/^--?/, ""), candidates.map((c) => c.replace(/^--?/, "")), {
    minLength: 2,
    minScore: 36,
    requirePrefix3: false,
  });
  if (!tip) {
    return { hint: "forge run --help  ·  forge --help" };
  }
  const flag = tip.startsWith("-") ? tip : `--${tip}`;
  return {
    suggestion: flag,
    hint: `Did you mean ${flag}?  ·  forge run --help`,
  };
}
