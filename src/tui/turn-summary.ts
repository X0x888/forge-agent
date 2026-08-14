import type { SessionData } from "../session/session.js";
import { isLastVerificationStale } from "../session/session.js";
import type { FileMutation } from "../session/mutations.js";
import { displayRelPath } from "../agent/tools/path-util.js";
import { clipAnsi, visibleWidth } from "../util/format.js";

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
  preferredCheck?: string | null,
): string | null {
  if (!edits.length) return null;
  const byPath = new Map<string, string>();
  for (const m of edits) byPath.set(m.path, m.kind);
  const names = [...byPath.entries()].map(([p, kind]) => {
    const label = displayRelPath(cwd, p);
    return kind === "create" ? `${label} (new)` : label;
  });
  const lv = meta.lastVerificationCommand?.trim();
  const next = preferredCheck?.trim();
  const verify = lv
    ? isLastVerificationStale(meta)
      ? `verify: ${lv} (stale — predates last edit)`
      : `verify: ${lv} ✓`
    : next
      ? `verify: none — run ${next}`
      : `verify: none — edits unverified`;
  const cols = process.stdout.isTTY ? process.stdout.columns || 80 : 80;
  const prefix = `  Δ ${byPath.size} file${byPath.size === 1 ? "" : "s"}: `;
  const suffix = `  ·  ${verify}`;
  const reserved = visibleWidth(prefix) + visibleWidth(suffix);
  if (reserved >= cols) {
    return `${prefix}${clipAnsi(suffix.trimStart(), Math.max(8, cols - visibleWidth(prefix)))}`;
  }
  const budget = cols - reserved;
  let shown = names.slice(0, 6);
  let more = names.length > shown.length ? ` +${names.length - shown.length} more` : "";
  while (
    shown.length > 1 &&
    visibleWidth(`${shown.join(", ")}${more}`) > budget
  ) {
    shown = shown.slice(0, -1);
    more = ` +${names.length - shown.length} more`;
  }
  let mid = `${shown.join(", ")}${more}`;
  if (visibleWidth(mid) > budget) mid = clipAnsi(mid, budget);
  return `${prefix}${mid}${suffix}`;
}
