/**
 * Hard safety rail — runs even when permission_mode = bypassPermissions.
 *
 * YOLO skips interactive prompts; it must NOT skip catastrophic denials.
 * Fail closed on known disaster patterns; everything else is the model's risk.
 */
import path from "node:path";
import os from "node:os";
import {
  commandCheckTargets,
  safetySegments,
  tokenizeSimple,
  normalizeSegment,
} from "./shell-parse.js";
import { forgeHome } from "../util/fs.js";
import { isProtectedWritePath, protectedWriteReason } from "./protected-paths.js";

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
    re: /\brm\b[^\n;|&]*(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)[^\n;|&]*(~|\$\{?HOME\}?|\/Users\/[^/\s]+\/?|\/home\/[^/\s]+\/?)(\s|$|;|&|\|)/,
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
    rule: "find-delete",
    re: /\bfind\b[\s\S]*\s-delete\b/,
    reason: "Refusing find … -delete (broad destructive walk)",
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
    re: /\bgit\b[\s\S]*\bpush\b[^\n;|&]*--force(-with-lease)?[^\n;|&]*\b(main|master)\b/,
    reason: "Refusing force-push to main/master",
  },
  {
    rule: "force-push-main-order",
    re: /\bgit\b[\s\S]*\bpush\b[^\n;|&]*\b(main|master)\b[^\n;|&]*--force(-with-lease)?/,
    reason: "Refusing force-push to main/master",
  },
  {
    rule: "force-push-main-short",
    re: /\bgit\b[\s\S]*\bpush\b[^\n;|&]*\s-f(\s|$)[^\n;|&]*\b(main|master)\b/,
    reason: "Refusing force-push (-f) to main/master",
  },
  {
    rule: "force-push-main-short-order",
    re: /\bgit\b[\s\S]*\bpush\b[^\n;|&]*\b(main|master)\b[^\n;|&]*\s-f(\s|$)/,
    reason: "Refusing force-push (-f) to main/master",
  },
  {
    rule: "git-clean-fdx",
    re: /\bgit\b[\s\S]*\bclean\b[^\n;|&]*-[a-zA-Z]*f[a-zA-Z]*d[a-zA-Z]*x/,
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
  {
    rule: "node-rm-root",
    // Matches rmSync("/") with optional escapes: "/", \\"/\\", '/'
    re: /\brmSync\s*\(\s*(?:\\?["'`])\/(?:\\?["'`])/,
    reason: "Refusing Node recursive delete of filesystem root",
  },
  {
    rule: "python-rmtree-root",
    re: /\brmtree\s*\(\s*(?:\\?["'`])\/(?:\\?["'`])/,
    reason: "Refusing Python rmtree of filesystem root",
  },
  {
    rule: "fs-rm-root-recursive",
    re: /\b(rmSync|rmdirSync|rmtree)\b[\s\S]{0,80}(?:\\?["'`])\/(?:\\?["'`])[\s\S]{0,80}recursive\s*:\s*true/,
    reason: "Refusing language-runtime recursive delete of filesystem root",
  },
  {
    // node/python/perl/ruby/php/lua spawning shell rm -rf /
    rule: "runtime-system-rm-root",
    re: /\b(system|execSync|exec\s*\(|spawnSync|os\.system|os\.execute|popen)\b[\s\S]{0,120}\brm\b[\s\S]{0,40}(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive)[\s\S]{0,40}(?:\\?["'`])?\/(?:\\?["'`])?/,
    reason: "Refusing language-runtime shell recursive delete of filesystem root",
  },
  {
    rule: "runtime-system-rm-home",
    re: /\b(system|execSync|exec\s*\(|spawnSync|os\.system|os\.execute|popen)\b[\s\S]{0,120}\brm\b[\s\S]{0,40}(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)[\s\S]{0,40}(~|\$\{?HOME\}?)/,
    reason: "Refusing language-runtime shell recursive delete of home",
  },
];

export const SOFT_DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)/,
  /\brm\s+--recursive/,
  /\bgit\s+[\s\S]*\bpush\s+[\s\S]*--force/,
  /\bgit\s+[\s\S]*\bpush\s+[\s\S]*\s-f(\s|$)/,
  /\bgit\s+[\s\S]*\breset\s+--hard/,
  // Skipping hooks can land unreviewed / unsafe commits or pushes
  // Require commit/push verb so `git add -n` / dry-run flags are not flagged.
  /\bgit\s+[\s\S]*\bcommit\b[\s\S]*--no-verify\b/,
  /\bgit\s+[\s\S]*\bcommit\b[\s\S]*(?:\s|^)-n(?:\s|$)/,
  /\bgit\s+[\s\S]*\bpush\b[\s\S]*--no-verify\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bdrop\s+table\b/i,
  /\bnpm\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\byarn\s+npm\s+publish\b/,
  /\bcurl\b[\s\S]*\s(-X\s*POST|-X\s*PUT|-d\s|--data|--upload-file|-T\s)/i,
  /\bwget\b[\s\S]*\s(--post-data|--method=POST)/i,
];

export function isSoftDangerousBash(command: string): boolean {
  return SOFT_DANGEROUS.some((re) => re.test(command));
}

const HOME_TARGETS = new Set([
  "~",
  "$HOME",
  "${HOME}",
  "${home}",
  "$home",
]);

/** Structured rm -rf of catastrophic targets (supplements regex). */
function structuredRmDeny(segment: string): SafetyVerdict | null {
  const toks = tokenizeSimple(normalizeSegment(segment));
  if (toks[0] !== "rm") return null;
  const flags = toks.filter((t) => t.startsWith("-") && t !== "-");
  const recursive =
    flags.some((f) => /r/i.test(f.replace(/^--/, "")) && !f.startsWith("--")) ||
    flags.includes("--recursive") ||
    flags.some(
      (f) =>
        f === "-rf" ||
        f === "-fr" ||
        /^-[a-zA-Z]*r[a-zA-Z]*f/.test(f) ||
        /^-[a-zA-Z]*f[a-zA-Z]*r/.test(f),
    );
  if (!recursive) return null;
  const targets = toks.filter((t) => !t.startsWith("-") || t === "-");
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
    if (HOME_TARGETS.has(t) || t === home || t === home + "/") {
      return {
        ok: false,
        reason: "Refusing recursive delete of home directory",
        rule: "rm-rf-structured-home",
      };
    }
  }
  return null;
}

/** Structured force-push to main/master (handles git -C, -f, flag order). */
function structuredGitForceMain(segment: string): SafetyVerdict | null {
  const toks = tokenizeSimple(normalizeSegment(segment));
  if (toks[0] !== "git") return null;

  // Peel git global options: -C path, -c key=val, --git-dir=…
  let i = 1;
  while (i < toks.length) {
    const t = toks[i];
    if (t === "-C" || t === "-c") {
      i += 2;
      continue;
    }
    if (t.startsWith("--git-dir") || t.startsWith("--work-tree")) {
      i += t.includes("=") ? 1 : 2;
      continue;
    }
    if (t.startsWith("-") && t !== "-" && !t.startsWith("--")) {
      // clustered short opts before subcommand — rare; skip single token
      i += 1;
      continue;
    }
    break;
  }
  if (toks[i] !== "push") return null;
  const rest = toks.slice(i + 1);
  const force =
    rest.includes("--force") ||
    rest.includes("--force-with-lease") ||
    rest.some((t) => t === "-f" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t));
  if (!force) return null;
  const refs = rest.filter((t) => !t.startsWith("-"));
  // refs like origin main, or HEAD:main, or main
  const hitsMain = refs.some((r) => {
    const base = r.includes(":") ? r.split(":").pop()! : r;
    return base === "main" || base === "master" || base.endsWith("/main") || base.endsWith("/master");
  });
  if (hitsMain || (refs.length >= 2 && (refs[1] === "main" || refs[1] === "master"))) {
    return {
      ok: false,
      reason: "Refusing force-push to main/master",
      rule: "git-force-push-main-structured",
    };
  }
  // `git push -f` with no ref often defaults to current branch — still dangerous if on main;
  // deny bare force-push without explicit non-main ref when only remote given
  if (refs.length <= 1 && force) {
    // remote only or nothing — treat as force-push of current branch: soft-dangerous, not hard
    return null;
  }
  return null;
}

function structuredFindDelete(segment: string): SafetyVerdict | null {
  const toks = tokenizeSimple(normalizeSegment(segment));
  if (toks[0] !== "find") return null;
  if (toks.includes("-delete")) {
    return {
      ok: false,
      reason: "Refusing find … -delete (broad destructive walk)",
      rule: "find-delete-structured",
    };
  }
  return null;
}

/** curl/wget segment piped to shell */
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
    const structured =
      structuredRmDeny(segment) ||
      structuredGitForceMain(segment) ||
      structuredFindDelete(segment);
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

  if (isProtectedWritePath(absolutePath)) {
    return {
      ok: false,
      reason: protectedWriteReason(absolutePath),
      rule: "write-protected-path",
    };
  }

  if (isSensitiveHomePath(p)) {
    const forge = forgeHome().replace(/\\/g, "/");
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
  if (name === "apply_patch" || name === "ApplyPatch") {
    const patchText = String(
      toolInput.patchText ?? toolInput.patch_text ?? toolInput.patch ?? "",
    );
    const paths = extractPatchPaths(patchText);
    const root = path.resolve(workspace);
    for (const p of paths) {
      const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspace, p);
      const v = checkWritePathHardDeny(abs, root);
      if (!v.ok) return v;
    }
    return { ok: true };
  }
  return { ok: true };
}

/** Best-effort path extraction from apply_patch text for hard-deny checks. */
function extractPatchPaths(patchText: string): string[] {
  const out: string[] = [];
  for (const line of String(patchText || "").split(/\r?\n/)) {
    const m = line.match(
      /^\*\*\* (?:Add|Delete|Update) File:\s*(.+?)\s*$/,
    );
    if (m?.[1]) out.push(m[1].trim());
    const move = line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
    if (move?.[1]) out.push(move[1].trim());
  }
  return out;
}
