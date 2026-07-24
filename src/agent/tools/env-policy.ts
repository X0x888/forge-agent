/**
 * Shell environment policy (Grok-inspired).
 * Default: inherit all, but drop names matching secret patterns.
 */

export type InheritMode = "all" | "core" | "none";

export interface ShellEnvPolicy {
  inherit?: InheritMode;
  /** When false (default), drop *KEY* / *SECRET* / *TOKEN* names */
  ignoreDefaultExcludes?: boolean;
  exclude?: string[];
  includeOnly?: string[];
  set?: Record<string, string>;
}

const CORE_ENV = new Set(
  [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "COLORTERM",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "PWD",
    "OLDPWD",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "SSH_AUTH_SOCK",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    // Node / tooling common
    "NODE_ENV",
    "npm_config_user_agent",
    "npm_config_prefix",
    "NVM_DIR",
    "FNM_DIR",
    "VOLTA_HOME",
    "HOMEBREW_PREFIX",
    "HOMEBREW_CELLAR",
    "HOMEBREW_REPOSITORY",
  ].map((s) => s.toLowerCase()),
);

const DEFAULT_SECRET_GLOBS = ["*KEY*", "*SECRET*", "*TOKEN*", "*PASSWORD*", "*CREDENTIAL*"];

function globMatch(pattern: string, name: string): boolean {
  // Case-insensitive * and ? globs
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  let pi = 0;
  let ni = 0;
  let star = -1;
  let match = 0;
  while (ni < n.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === n[ni])) {
      pi++;
      ni++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi++;
      match = ni;
    } else if (star !== -1) {
      pi = star + 1;
      ni = ++match;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

function matchesAny(globs: string[], name: string): boolean {
  return globs.some((g) => globMatch(g, name));
}

/**
 * Build env for agent subprocesses. Defaults scrub secret-looking names.
 */
export function createShellEnv(
  base: NodeJS.ProcessEnv = process.env,
  policy: ShellEnvPolicy = {},
): NodeJS.ProcessEnv {
  const inherit = policy.inherit ?? "all";
  const ignoreDefault = policy.ignoreDefaultExcludes ?? false;
  const exclude = policy.exclude ?? [];
  const includeOnly = policy.includeOnly ?? [];
  const set = policy.set ?? {};

  const out: NodeJS.ProcessEnv = {};

  if (inherit !== "none") {
    for (const [k, v] of Object.entries(base)) {
      if (v === undefined) continue;
      if (inherit === "core" && !CORE_ENV.has(k.toLowerCase())) continue;
      if (!ignoreDefault && matchesAny(DEFAULT_SECRET_GLOBS, k)) {
        // Keep a few operational exceptions that are not credentials
        const lower = k.toLowerCase();
        if (
          lower === "keytimeout" ||
          lower.endsWith("keyboard") ||
          lower.includes("keybinding")
        ) {
          /* keep */
        } else {
          continue;
        }
      }
      if (matchesAny(exclude, k)) continue;
      if (includeOnly.length && !matchesAny(includeOnly, k)) continue;
      out[k] = v;
    }
  }

  for (const [k, v] of Object.entries(set)) {
    out[k] = v;
  }

  // Always ensure PATH/HOME exist if present in base and not stripped by includeOnly alone
  if (!out.PATH && base.PATH) out.PATH = base.PATH;
  if (!out.HOME && base.HOME) out.HOME = base.HOME;

  return out;
}
