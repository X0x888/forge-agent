/**
 * Shell environment policy (Grok-inspired).
 * Default: inherit all, but drop names matching secret patterns.
 * Forge/LLM provider keys are always stripped from inherit — including
 * MCP/LSP keepSecrets — unless policy `set` (mcp.json env) reintroduces them.
 */
import { isProviderApiKeyEnv } from "../../auth/env-keys.js";

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

const DEFAULT_SECRET_GLOBS = [
  "*KEY*",
  "*SECRET*",
  "*TOKEN*",
  "*PASSWORD*",
  "*CREDENTIAL*",
  // Connection strings often embed user:pass@host — not matched by *KEY*/*TOKEN*
  "*DATABASE_URL*",
  "*DB_URL*",
  "*MONGO_URL*",
  "*MONGODB_URL*",
  "*REDIS_URL*",
  "*AMQP_URL*",
  "*POSTGRES_URL*",
  "*MYSQL_URL*",
  "*CONNECTION_STRING*",
  "*CONN_STRING*",
  "*DATABASE_URI*",
  "*DB_URI*",
  "*MONGO_URI*",
  "*MONGODB_URI*",
  "*REDIS_URI*",
  "*AMQP_URI*",
  "*POSTGRES_URI*",
  "*MYSQL_URI*",
  // DB client password files / env not matching *PASSWORD*
  "MYSQL_PWD",
  "PGPASSFILE",
  // TLS session key log (exfil risk if set in host env)
  "SSLKEYLOGFILE",
];

/**
 * Host env vars that can inject code into child processes.
 * Always stripped unless the policy explicitly `set`s them.
 */
export const SHELL_INJECTION_ENV = new Set(
  [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FORCE_FLAT_NAMESPACE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONSTARTUP",
    "PYTHONPATH",
    "PERL5OPT",
    "RUBYOPT",
    "BASH_ENV",
    "ENV",
    "SHELLOPTS",
    "BASHOPTS",
    "PROMPT_COMMAND",
    "IFS",
    // Git config/env injection (core.sshCommand, external diff, etc.)
    "GIT_SSH_COMMAND",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_EXEC_PATH",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_OBJECT_DIRECTORY",
    "GIT_INDEX_FILE",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
  ].map((s) => s.toLowerCase()),
);

/** Prefix match for numbered GIT_CONFIG_KEY_N / GIT_CONFIG_VALUE_N */
function isGitConfigInjectionEnv(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.startsWith("git_config_key_") ||
    n.startsWith("git_config_value_") ||
    n.startsWith("git_config_count")
  );
}

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
 * Env for Forge-spawned children (git helpers, formatters, lsp ensure,
 * hooks, grep). Scrubs secrets + injection (`GIT_DIR`, `NODE_OPTIONS`, …).
 * `extra` is policy `set` — reintroduces names after the scrub (checkpoint
 * temp index, hook `FORGE_*`). MCP/LSP stdio pass `{ keepSecrets: true }` so
 * a host `GITHUB_TOKEN` still reaches the server; Forge provider keys
 * (`XAI_API_KEY`, `CURSOR_ACCESS_TOKEN`, …) stay stripped unless `set`.
 * Injection is always stripped.
 */
export function createChildEnv(
  extra?: NodeJS.ProcessEnv,
  opts?: { keepSecrets?: boolean; base?: NodeJS.ProcessEnv },
): NodeJS.ProcessEnv {
  const set: Record<string, string> = {};
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) set[k] = v;
    }
  }
  return createShellEnv(opts?.base ?? process.env, {
    ignoreDefaultExcludes: Boolean(opts?.keepSecrets),
    ...(Object.keys(set).length ? { set } : {}),
  });
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
      const lowerName = k.toLowerCase();
      // Always drop process-injection vectors (preload / interpreter opts).
      // Policy `set` can still reintroduce them deliberately below.
      if (SHELL_INJECTION_ENV.has(lowerName) || isGitConfigInjectionEnv(k)) continue;
      // Always drop Forge/LLM credentials from inherit. keepSecrets still
      // passes GITHUB_TOKEN; mcp.json env overlay (`set`) can reintroduce
      // a provider key on purpose.
      if (isProviderApiKeyEnv(k)) continue;
      if (!ignoreDefault && matchesAny(DEFAULT_SECRET_GLOBS, k)) {
        // Keep a few operational exceptions that are not credentials
        if (
          lowerName === "keytimeout" ||
          lowerName.endsWith("keyboard") ||
          lowerName.includes("keybinding")
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
