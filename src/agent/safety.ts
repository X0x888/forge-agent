/**
 * Hard safety rail — runs even when permission_mode = bypassPermissions.
 *
 * YOLO skips interactive prompts; it must NOT skip catastrophic denials.
 * Fail closed on known disaster patterns; everything else is the model's risk.
 */
import path from "node:path";
import os from "node:os";
import { commandCheckTargets, safetySegments, tokenizeSimple, normalizeSegment } from "./shell-parse.js";
import { forgeHome } from "../util/fs.js";

export type SafetyVerdict =
  | { ok: true }
  | { ok: false; reason: string; rule: string };

/** Patterns that are never allowed via bash, regardless of permission mode. */
const HARD_DENY: Array<{ rule: string; re: RegExp; reason: string }> = [
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
  {
    rule: "drop-database",
    re: /\bdrop\s+database\b/i,
    reason: "Refusing DROP DATABASE",
  },
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

/** Structured rm -rf of catastrophic targets (supplements regex). */
function structuredRmDeny(segment: string): SafetyVerdict | null {
  const toks = tokenizeSimple(normalizeSegment(segment));
  if (toks[0] !== "rm") return null;
  const flags = toks.filter((t) => t.startsWith("-") && t !== "-");
  const recursive =
    flags.some((f) => /r/i.test(f.replace(/^--/, "")) && !f.startsWith("--")) ||
    flags.includes("--recursive") ||
    flags.some((f) => f === "-rf" || f === "-fr" || /^-[a-zA-Z]*r[a-zA-Z]*f/.test(f) || /^-[a-zA-Z]*f[a-zA-Z]*r/.test(f));
  if (!recursive) return null;
  const targets = toks.filter((t) => !t.startsWith("-") || t === "-");
  // drop "rm"
  const paths = targets.slice(1);
  const home = os.homedir().replace(/\\/g, "/");
  for (const raw of paths) {
    const t = raw.replace(/\\/g, "/");
    if (t === "/" || t === "/*" || t === "*") {
      return {
        ok: false,
        reason: "Refusing recursive delete targeting filesystem root/wildcard",
        rule: "rm-rf-structured",
      };
    }
    if (t === "~" || t === "$HOME" || t === home || t === home + "/") {
      return {
        ok: false,
        reason: "Refusing recursive delete of home directory",
        rule: "rm-rf-structured-home",
      };
    }
  }
  return null;
}

/** curl/wget segment piped to shell: check adjacent segments of full command. */
function structuredCurlPipeSh(command: string): SafetyVerdict | null {
  const segs = safetySegments(command);
  for (let i = 0; i < segs.length - 1; i++) {
    const a = primaryWord(segs[i]);
    const b = primaryWord(segs[i + 1]);
    if ((a === "curl" || a === "wget") && (b === "sh" || b === "bash" || b === "zsh")) {
      return {
        ok: false,
        reason: "Refusing curl|sh / wget|sh remote code execution",
        rule: "curl-pipe-shell-structured",
      };
    }
  }
  // also full string for `curl x | sh` when split works
  if (/\b(curl|wget)\b/.test(command) && /\|\s*(ba)?sh\b/.test(command)) {
    return {
      ok: false,
      reason: "Refusing curl|sh / wget|sh remote code execution",
      rule: "curl-pipe-shell-structured",
    };
  }
  return null;
}

function primaryWord(segment: string): string {
  return tokenizeSimple(normalizeSegment(segment))[0] || "";
}

export function checkBashHardDeny(command: string): SafetyVerdict {
  const cmd = command.trim();
  if (!cmd) return { ok: true };

  const pipe = structuredCurlPipeSh(cmd);
  if (pipe) return pipe;

  const targets = commandCheckTargets(cmd);
  for (const segment of targets) {
    const structured = structuredRmDeny(segment);
    if (structured) return structured;

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

function isSensitiveHomePath(p: string): boolean {
  return (
    /\/(\.ssh|\.gnupg)\//.test(p) ||
    /\/\.(bashrc|zshrc|profile|zprofile|bash_profile)$/.test(p) ||
    /\/\.forge\/auth\.json$/.test(p) ||
    /\/\.forge\/hooks\//.test(p) ||
    /\/\.forge\/permissions\.json$/.test(p) ||
    /\/Library\/Application Support\/Claude\//i.test(p) ||
    /\/\.cursor\/mcp\.json$/.test(p) ||
    /\/\.config\/gh\//.test(p)
  );
}

export function checkWritePathHardDeny(
  absolutePath: string,
  workspace: string,
): SafetyVerdict {
  const p = absolutePath.replace(/\\/g, "/");
  for (const prefix of FORBIDDEN_WRITE_PREFIXES) {
    if (p === prefix || p.startsWith(prefix + "/")) {
      return {
        ok: false,
        reason: `Refusing write outside safe area: ${prefix}`,
        rule: "write-system-path",
      };
    }
  }
  // Always block sensitive home/config paths even inside a workspace named oddly
  if (isSensitiveHomePath(p)) {
    const forge = forgeHome().replace(/\\/g, "/");
    // allow writes under workspace only if NOT sensitive forge/auth — still deny auth/hooks
    if (/\/\.forge\/(auth\.json|permissions\.json)$/.test(p) || /\/\.forge\/hooks\//.test(p)) {
      return {
        ok: false,
        reason: "Refusing write to Forge credentials/hooks",
        rule: "write-forge-protected",
      };
    }
    if (!p.startsWith(workspace.replace(/\\/g, "/") + "/") && !p.startsWith(forge + "/sessions")) {
      return {
        ok: false,
        reason: "Refusing write to sensitive home config outside workspace",
        rule: "write-sensitive-home",
      };
    }
    if (/\/(\.ssh|\.gnupg)\//.test(p) || /\/\.(bashrc|zshrc|profile|zprofile|bash_profile)$/.test(p)) {
      return {
        ok: false,
        reason: "Refusing write to sensitive home config",
        rule: "write-sensitive-home",
      };
    }
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
