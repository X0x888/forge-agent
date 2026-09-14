/**
 * Session recovery keys: CLI vs REPL is a parameter.
 * slash.ts / doctor / sessions --help import this — they do not own a second table.
 */
export type SitDownSurface = "repl" | "cli";

export type SessionsRecoveryKind =
  | "errors"
  | "untitled"
  | "pinned"
  | "pin"
  | "unpin"
  | "search"
  | "journals"
  | "prune"
  | "orphans";

const SESSIONS_RECOVERY: Record<
  SessionsRecoveryKind,
  { cli: string; repl: string }
> = {
  errors: { cli: "forge sessions errors", repl: "/sessions errors" },
  untitled: { cli: "forge sessions untitled", repl: "/sessions untitled" },
  pinned: { cli: "forge sessions pinned", repl: "/sessions pinned" },
  pin: { cli: "forge sessions pin", repl: "/pin" },
  unpin: { cli: "forge sessions unpin", repl: "/unpin" },
  search: { cli: "forge sessions list -q", repl: "/sessions search" },
  journals: {
    cli: "forge sessions prune --journals",
    repl: "/sessions prune --journals",
  },
  prune: {
    cli: "forge sessions prune --keep 50 --dry",
    repl: "/sessions prune --keep 50 --dry",
  },
  orphans: {
    cli: "forge sessions prune --orphans",
    repl: "/sessions prune --orphans",
  },
};

export function sessionsRecoveryVerb(
  kind: SessionsRecoveryKind,
  surface: SitDownSurface,
): string {
  const row = SESSIONS_RECOVERY[kind];
  return surface === "cli" ? row.cli : row.repl;
}

/** Alias used by doctor-card / existing tests. */
export const doctorSessionsRecoveryVerb = sessionsRecoveryVerb;

export type DoctorSessionsRecoveryKind = SessionsRecoveryKind;

export function doctorForceLastErrorHelp(
  surface: SitDownSurface = "cli",
): string {
  return (
    "Prune: also delete sessions that still carry lastError (default: keep for " +
    `${sessionsRecoveryVerb("errors", surface)})`
  );
}

export function formatDoctorPinnedLine(
  n: number,
  surface: SitDownSurface,
): string {
  const pinned = sessionsRecoveryVerb("pinned", surface);
  const unpin = sessionsRecoveryVerb("unpin", surface);
  const pin = sessionsRecoveryVerb("pin", surface);
  if (n >= 10) {
    return `  ⚠ ${n} pinned sessions (prune-protected) — ${pinned} · ${unpin} stale keepers`;
  }
  return `  pinned sessions: ${n}  →  ${pinned} · ${pin} protects from prune`;
}

export function formatPinnedEmpty(surface: SitDownSurface): string {
  return `No pinned sessions. ${sessionsRecoveryVerb("pin", surface)} <id> protects from prune.`;
}

export function titleSearchHelp(surface: SitDownSurface = "cli"): string {
  return `Label for a new session (searchable via ${sessionsRecoveryVerb("search", surface)})`;
}

export function formatUntitledEmpty(surface: SitDownSurface): string {
  return surface === "cli"
    ? `No untitled sessions. --title labels new ones.`
    : "No untitled sessions. /title · --title · /goal set auto-titles new ones.";
}
