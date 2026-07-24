/**
 * Paths the agent must never write via native file tools (Bar A daily-driver).
 * Bash still goes through OS sandbox + hard-deny; this covers write_file/edit.
 */
import path from "node:path";
import os from "node:os";
import { forgeHome } from "../util/fs.js";

export function normalizeFsPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

/** True if absolute path is a credential/config surface we never overwrite. */
export function isProtectedWritePath(absolutePath: string): boolean {
  const p = normalizeFsPath(absolutePath);
  const home = os.homedir().replace(/\\/g, "/");
  const forge = forgeHome().replace(/\\/g, "/");

  // Forge credentials & permission memory
  if (
    p === `${forge}/auth.json` ||
    p === `${forge}/permissions.json` ||
    p === `${forge}/preferences.json` ||
    p.startsWith(`${forge}/hooks/`)
  ) {
    return true;
  }

  // Only sessions/logs/tmp under ~/.forge are agent-writable
  if (p === forge || p.startsWith(forge + "/")) {
    if (
      p.startsWith(`${forge}/sessions/`) ||
      p.startsWith(`${forge}/logs/`) ||
      p.startsWith(`${forge}/tmp/`)
    ) {
      return false;
    }
    // config.toml etc. — not via agent file tools
    if (
      p === `${forge}/config.toml` ||
      p === `${forge}/config.json` ||
      p === `${forge}/preferences.json` ||
      p.endsWith("/auth.json") ||
      p.endsWith("/permissions.json") ||
      p.endsWith("/preferences.json")
    ) {
      return true;
    }
  }

  // Git metadata that can turn a repo into a remote-code vector
  if (/\/\.git\/hooks(\/|$)/.test(p)) return true;
  if (/\/\.git\/config$/.test(p)) return true;
  if (/\/\.git\/HEAD$/.test(p)) return true;

  // SSH / shell RC / common secret files in home
  if (
    p.startsWith(`${home}/.ssh/`) ||
    p.startsWith(`${home}/.gnupg/`) ||
    /\/\.(bashrc|zshrc|profile|zprofile|bash_profile)$/.test(p)
  ) {
    return true;
  }

  // Workspace-relative secrets by basename path
  if (
    /\/\.env(\.|$)/.test(p) ||
    /\/\.env\.[^/]+$/.test(p) ||
    p.endsWith("/id_rsa") ||
    p.endsWith("/id_ed25519") ||
    p.endsWith("/credentials.json")
  ) {
    // .env in project is common for agents to edit — only block classic private keys
    if (p.endsWith("/id_rsa") || p.endsWith("/id_ed25519") || /\/\.ssh\//.test(p)) {
      return true;
    }
  }

  return false;
}

export function protectedWriteReason(absolutePath: string): string {
  const p = normalizeFsPath(absolutePath);
  if (p.includes("/.forge/")) return "Refusing write to Forge credentials/config/hooks";
  if (p.includes("/.git/")) return "Refusing write to .git metadata (hooks/config/HEAD)";
  if (p.includes("/.ssh/") || p.includes("/.gnupg/")) {
    return "Refusing write to SSH/GPG material";
  }
  return `Refusing write to protected path: ${p}`;
}
