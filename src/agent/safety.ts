/**
 * Hard safety rail — runs even when permission_mode = bypassPermissions.
 *
 * YOLO skips interactive prompts; it must NOT skip catastrophic denials.
 * Fail closed on known disaster patterns; everything else is the model's risk.
 */
import path from "node:path";
import { commandCheckTargets } from "./shell-parse.js";

export type SafetyVerdict =
  | { ok: true }
  | { ok: false; reason: string; rule: string };

/** Patterns that are never allowed via bash, regardless of permission mode. */
const HARD_DENY: Array<{ rule: string; re: RegExp; reason: string }> = [
  // Filesystem annihilation — match common rm -rf / forms
  {
    rule: "rm-rf-root",
    re: /\brm\b[^\n;|&]*\s(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive)[^\n;|&]*(\s|^)\/(\s|$|;|&|\|)/,
    reason: "Refusing recursive delete targeting filesystem root",
  },
  {
    rule: "rm-rf-root-end",
    re: /\brm\b[^\n;|&]*(-rf|-fr|--recursive)[^\n;|&]*\s+\/\s*$/,
    reason: "Refusing recursive delete targeting filesystem root",
  },
  {
    rule: "rm-rf-home",
    re: /\brm\b[^\n;|&]*(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)[^\n;|&]*(~|\$HOME|\/Users\/[^/\s]+\/?|\/home\/[^/\s]+\/?)(\s|$|;|&|\|)/,
    reason: "Refusing recursive delete of home directory",
  },
  {
    rule: "rm-rf-star",
    re: /\brm\b[^\n;|&]*(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)[^\n;|&]*(\s|^)(\*|\/\*)(\s|$|;|&|\|)/,
    reason: "Refusing recursive delete with broad wildcard",
  },
  {
    rule: "rm-rf-dotdot",
    re: /\brm\b[^\n;|&]*(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)[^\n;|&]*\s+\.\.(\s|\/|$)/,
    reason: "Refusing recursive delete of parent directory",
  },
  // Disk / device destruction
  {
    rule: "mkfs",
    re: /\bmkfs(\.\w+)?\b/,
    reason: "Refusing filesystem format (mkfs)",
  },
  {
    rule: "dd-device",
    re: /\bdd\b[^\n;|&]*\bof=\/dev\//,
    reason: "Refusing dd write to block device",
  },
  {
    rule: "diskutil-erase",
    re: /\bdiskutil\s+(erase|partition)Disk\b/i,
    reason: "Refusing diskutil erase/partition",
  },
  // Privilege + remote code
  {
    rule: "curl-pipe-shell",
    re: /\b(curl|wget)\b[^\n;|&]*\|\s*(ba)?sh\b/,
    reason: "Refusing curl|sh / wget|sh remote code execution",
  },
  {
    rule: "sudo-rm",
    re: /\bsudo\s+[^\n;|&]*\brm\s+[^\n;|&]*-[a-zA-Z]*r/,
    reason: "Refusing sudo recursive rm",
  },
  // Git catastrophe on shared branches
  {
    rule: "force-push-main",
    re: /\bgit\s+push\b[^\n;|&]*--force(-with-lease)?[^\n;|&]*\b(main|master)\b/,
    reason: "Refusing force-push to main/master",
  },
  {
    rule: "force-push-main-order",
    re: /\bgit\s+push\b[^\n;|&]*\b(main|master)\b[^\n;|&]*--force(-with-lease)?/,
    reason: "Refusing force-push to main/master",
  },
  {
    rule: "git-clean-fdx",
    re: /\bgit\s+clean\b[^\n;|&]*-[a-zA-Z]*f[a-zA-Z]*d[a-zA-Z]*x/,
    reason: "Refusing git clean -fdx (destroys untracked + ignored)",
  },
  // DB wipe
  {
    rule: "drop-database",
    re: /\bdrop\s+database\b/i,
    reason: "Refusing DROP DATABASE",
  },
  // Fork bombs / kernel
  {
    rule: "fork-bomb",
    re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;?/,
    reason: "Refusing fork bomb",
  },
  {
    rule: "shutdown-reboot",
    re: /\b(shutdown|reboot|halt|poweroff)\b/,
    reason: "Refusing system power command",
  },
];

/**
 * Soft-dangerous: still allowed in bypass, but flagged for logging / non-bypass ask.
 * Kept separate so YOLO stays useful without enabling planet-killers.
 */
export const SOFT_DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)/,
  /\brm\s+--recursive/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bchmod\s+-R\s+777\b/,
  /\bdrop\s+table\b/i,
];

export function isSoftDangerousBash(command: string): boolean {
  return SOFT_DANGEROUS.some((re) => re.test(command));
}

export function checkBashHardDeny(command: string): SafetyVerdict {
  const cmd = command.trim();
  if (!cmd) return { ok: true };
  // Segment-aware: `ls && rm -rf /` must deny even if only one segment is bad
  const targets = commandCheckTargets(cmd);
  for (const segment of targets) {
    for (const rule of HARD_DENY) {
      if (rule.re.test(segment)) {
        return {
          ok: false,
          reason: `${rule.reason} (segment: ${segment.slice(0, 80)})`,
          rule: rule.rule,
        };
      }
    }
  }
  return { ok: true };
}

/** Paths that must never be written even if somehow resolved. */
const FORBIDDEN_WRITE_PREFIXES = [
  "/etc",
  "/System",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/var/root",
];

export function checkWritePathHardDeny(
  absolutePath: string,
  workspace: string,
): SafetyVerdict {
  const p = absolutePath.replace(/\\/g, "/");
  // Always block known system paths
  for (const prefix of FORBIDDEN_WRITE_PREFIXES) {
    if (p === prefix || p.startsWith(prefix + "/")) {
      return {
        ok: false,
        reason: `Refusing write outside safe area: ${prefix}`,
        rule: "write-system-path",
      };
    }
  }
  // Block writing SSH keys / shell rc in home even if agent tries absolute path
  const homeish =
    /\/(\.ssh|\.gnupg)\//.test(p) ||
    /\/\.(bashrc|zshrc|profile|zprofile|bash_profile)$/.test(p);
  if (homeish && !p.startsWith(workspace.replace(/\\/g, "/") + "/")) {
    return {
      ok: false,
      reason: "Refusing write to sensitive home config outside workspace",
      rule: "write-sensitive-home",
    };
  }
  return { ok: true };
}

/**
 * Unified pre-execution check used by the agent loop for every tool call.
 * Cannot be skipped by bypassPermissions.
 */
export function hardSafetyCheck(
  toolName: string,
  toolInput: Record<string, unknown>,
  workspace: string,
): SafetyVerdict {
  const name = toolName;
  if (name === "bash" || name === "run_terminal_command") {
    return checkBashHardDeny(String(toolInput.command || ""));
  }
  if (
    name === "write_file" ||
    name === "Write" ||
    name === "search_replace" ||
    name === "Edit"
  ) {
    const p = String(toolInput.path || "");
    if (!p) return { ok: true };
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspace, p);
    return checkWritePathHardDeny(abs, path.resolve(workspace));
  }
  return { ok: true };
}
