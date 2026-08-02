import path from "node:path";
import type { SessionData } from "../session/session.js";
import { isLastVerificationStale } from "../session/session.js";
import type { FileMutation } from "../session/mutations.js";

/**
 * Pure formatter for the end-of-turn change summary (unattended runs):
 * which files actually changed on disk this turn + whether a verification
 * command has run since the last edit. Returns null when nothing was
 * edited — the REPL stays silent then.
 */
export function formatTurnChangeSummary(
  edits: FileMutation[],
  cwd: string,
  meta: SessionData["meta"],
): string | null {
  if (!edits.length) return null;
  const byPath = new Map<string, string>();
  for (const m of edits) byPath.set(m.path, m.kind);
  const names = [...byPath.entries()].map(([p, kind]) => {
    const rel = path.relative(cwd, p);
    const label =
      rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
    return kind === "create" ? `${label} (new)` : label;
  });
  const shown = names.slice(0, 6);
  const more =
    names.length > shown.length ? ` +${names.length - shown.length} more` : "";
  const lv = meta.lastVerificationCommand?.trim();
  const verify = lv
    ? isLastVerificationStale(meta)
      ? `verify: ${lv} (stale — predates last edit)`
      : `verify: ${lv} ✓`
    : `verify: none — edits unverified`;
  return `  Δ ${byPath.size} file${byPath.size === 1 ? "" : "s"}: ${shown.join(", ")}${more}  ·  ${verify}`;
}
