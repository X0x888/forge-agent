import fs from "node:fs";
import path from "node:path";
import toml from "toml";
import { forgeHome, readJsonFile } from "../util/fs.js";
import {
  DEFAULT_CONFIG,
  type ForgeConfig,
  type PermissionConfig,
  type PermissionMode,
  type ProviderId,
  type SandboxMissingBackend,
  type SandboxNetwork,
  type SandboxProfile,
  type ReadOutsideWorkspace,
} from "./types.js";
import { applyPreferences, loadPreferences } from "./preferences.js";
import {
  clampEffortForModel,
  parseReasoningEffort,
} from "./reasoning.js";
import { modelContextWindow } from "./model-info.js";
import { normalizeProviderId } from "../util/provider-id.js";
import {
  normalizePermissionMode,
  normalizeSandboxProfile,
  normalizeSandboxNetwork,
} from "../util/mode-aliases.js";
import { coerceBool } from "../util/bool.js";

const ENV_PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);
const ENV_SANDBOX_PROFILES = new Set<SandboxProfile>([
  "off",
  "workspace",
  "read-only",
  "strict",
]);
const ENV_SANDBOX_NETWORKS = new Set<SandboxNetwork>(["unrestricted", "blocked"]);
const ENV_SANDBOX_MISSING = new Set<SandboxMissingBackend>([
  "fail-closed",
  "fallback",
]);
const ENV_READ_OUTSIDE = new Set<ReadOutsideWorkspace>(["ask", "allow", "deny"]);
const ENV_PROVIDERS = new Set<string>([
  "xai",
  "grok",
  "anthropic",
  "openai",
  "openrouter",
  "deepseek",
  "ds",
  "google",
  "copilot",
  "github-copilot",
  "github_copilot",
  "gh-copilot",
  "github",
  "custom",
]);

function deepMerge<T extends Record<string, unknown>>(base: T, overlay: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) continue;
    const prev = out[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      prev &&
      typeof prev === "object" &&
      !Array.isArray(prev)
    ) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** Map snake_case TOML keys onto camelCase ForgeConfig fields. */
function normalizeConfigShape(raw: Record<string, unknown>): Partial<ForgeConfig> {
  const out: Record<string, unknown> = { ...raw };
  const map: Record<string, string> = {
    max_tokens: "maxTokens",
    max_turns: "maxTurns",
    max_cost_usd: "maxCostUsd",
    max_cost: "maxCostUsd",
    permission_mode: "permissionMode",
    blocking_stop_hooks: "blockingStopHooks",
    compat_claude_hooks: "compatClaudeHooks",
    compat_cursor_hooks: "compatCursorHooks",
    auto_compact_threshold: "autoCompactThreshold",
    context_window: "contextWindow",
    base_url: "baseUrl",
    system_prompt_extra: "systemPromptExtra",
    prompt_profile: "promptProfile",
    sandbox_network: "sandboxNetwork",
    sandbox_missing_backend: "sandboxMissingBackend",
    read_outside_workspace: "readOutsideWorkspace",
    reasoning_effort: "reasoningEffort",
    effort: "reasoningEffort",
  };
  for (const [snake, camel] of Object.entries(map)) {
    if (snake in out && !(camel in out)) {
      out[camel] = out[snake];
      delete out[snake];
    }
  }
  if (out.goal && typeof out.goal === "object") {
    const g = { ...(out.goal as Record<string, unknown>) };
    if ("stuck_threshold" in g && !("stuckThreshold" in g)) {
      g.stuckThreshold = g.stuck_threshold;
      delete g.stuck_threshold;
    }
    if ("auto_arm" in g && !("autoArm" in g)) {
      g.autoArm = g.auto_arm;
      delete g.auto_arm;
    }
    out.goal = g;
  }
  if (out.permission && typeof out.permission === "object") {
    const p = { ...(out.permission as Record<string, unknown>) };
    for (const k of ["deny", "allow", "ask", "rules"] as const) {
      if (p[k] === undefined) p[k] = k === "rules" ? [] : [];
    }
    out.permission = p;
  }
  return out as Partial<ForgeConfig>;
}

function loadToml(file: string): Partial<ForgeConfig> {
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    return normalizeConfigShape(toml.parse(raw) as Record<string, unknown>);
  } catch (err) {
    console.error(`forge: failed to parse ${file}:`, err);
    return {};
  }
}

function loadJson(file: string): Partial<ForgeConfig> {
  return normalizeConfigShape(
    readJsonFile<Record<string, unknown>>(file, {}),
  );
}

/**
 * Grok-style trust: project configs may only *add* deny rules, never remove
 * global denials. Allow/ask from project still merge normally.
 */
export function mergePermissionTrust(
  globalPerm: PermissionConfig | undefined,
  projectPerm: PermissionConfig | undefined,
  base: PermissionConfig,
): PermissionConfig {
  const gDeny = new Set([...(base.deny || []), ...(globalPerm?.deny || [])]);
  const pDeny = projectPerm?.deny || [];
  const deny = [...gDeny];
  for (const d of pDeny) {
    if (!gDeny.has(d)) deny.push(d);
  }
  return {
    deny,
    allow: [
      ...(base.allow || []),
      ...(globalPerm?.allow || []),
      ...(projectPerm?.allow || []),
    ],
    ask: [
      ...(base.ask || []),
      ...(globalPerm?.ask || []),
      ...(projectPerm?.ask || []),
    ],
    rules: [
      ...(base.rules || []),
      ...(globalPerm?.rules || []),
      ...(projectPerm?.rules || []),
    ],
  };
}

/**
 * Bar A footgun guard: project `.forge/config` must not weaken the host safety
 * posture (credential redirect, YOLO, sandbox off, missing-backend fallback,
 * unrestricted outside reads). Global ~/.forge + env + CLI still can.
 */
export function applySafeProjectOverlay(
  globalCfg: ForgeConfig,
  projectRaw: Partial<ForgeConfig>,
): ForgeConfig {
  const cfg = { ...globalCfg };

  // Safe / useful project knobs
  if (projectRaw.model) cfg.model = projectRaw.model;
  if (projectRaw.reasoningEffort) cfg.reasoningEffort = projectRaw.reasoningEffort;
  if (typeof projectRaw.temperature === "number") cfg.temperature = projectRaw.temperature;
  if (typeof projectRaw.maxTokens === "number") cfg.maxTokens = projectRaw.maxTokens;
  if (typeof projectRaw.maxTurns === "number") cfg.maxTurns = projectRaw.maxTurns;
  if (projectRaw.systemPromptExtra) cfg.systemPromptExtra = projectRaw.systemPromptExtra;
  if (typeof projectRaw.autoCompactThreshold === "number") {
    cfg.autoCompactThreshold = projectRaw.autoCompactThreshold;
  }
  if (typeof projectRaw.contextWindow === "number") {
    cfg.contextWindow = projectRaw.contextWindow;
  }
  if (projectRaw.goal && typeof projectRaw.goal === "object") {
    cfg.goal = { ...cfg.goal, ...projectRaw.goal };
  }

  // permissionMode: allow default|acceptEdits|plan|dontAsk — never project YOLO
  // Normalize aliases first so yolo/always/bypass cannot slip past the block.
  if (projectRaw.permissionMode) {
    const mode =
      normalizePermissionMode(projectRaw.permissionMode) ??
      projectRaw.permissionMode;
    if (mode === "bypassPermissions") {
      console.error(
        "forge: ignoring project permission_mode=bypassPermissions (set in ~/.forge or CLI)",
      );
    } else if (ENV_PERMISSION_MODES.has(mode as PermissionMode)) {
      cfg.permissionMode = mode as PermissionMode;
    }
  }

  // sandbox: allow tighter profiles; never sandbox=off from project
  // Normalize aliases first so none/false/0 cannot slip past the off block.
  if (projectRaw.sandbox) {
    const profile =
      normalizeSandboxProfile(projectRaw.sandbox) ?? projectRaw.sandbox;
    if (profile === "off") {
      console.error(
        "forge: ignoring project sandbox=off (set in ~/.forge or CLI / FORGE_SANDBOX)",
      );
    } else if (
      profile === "workspace" ||
      profile === "read-only" ||
      profile === "strict"
    ) {
      cfg.sandbox = profile;
    }
  }

  // network: project may only tighten to blocked (aliases: none/off/deny → blocked)
  {
    const net =
      projectRaw.sandboxNetwork != null
        ? normalizeSandboxNetwork(projectRaw.sandboxNetwork) ??
          projectRaw.sandboxNetwork
        : null;
    if (net === "blocked") {
      cfg.sandboxNetwork = "blocked";
    } else if (net === "unrestricted") {
      // only if global already unrestricted — do not open network from project alone
      if (
        globalCfg.sandboxNetwork === "unrestricted" ||
        !globalCfg.sandboxNetwork
      ) {
        /* leave default-from-profile */
      }
    }
  }

  // missing backend: project cannot force fallback
  if (projectRaw.sandboxMissingBackend === "fail-closed") {
    cfg.sandboxMissingBackend = "fail-closed";
  } else if (projectRaw.sandboxMissingBackend === "fallback") {
    console.error(
      "forge: ignoring project sandbox_missing_backend=fallback (set globally if you must)",
    );
  }

  // outside workspace: project may tighten to deny/ask, never allow
  if (projectRaw.readOutsideWorkspace === "allow") {
    console.error(
      "forge: ignoring project read_outside_workspace=allow (set in ~/.forge or CLI)",
    );
  } else if (
    projectRaw.readOutsideWorkspace === "deny" ||
    projectRaw.readOutsideWorkspace === "ask"
  ) {
    cfg.readOutsideWorkspace = projectRaw.readOutsideWorkspace;
  }

  // baseUrl / provider / providers: never from project (credential redirect)
  if (projectRaw.baseUrl && projectRaw.baseUrl !== globalCfg.baseUrl) {
    console.error(
      "forge: ignoring project base_url (credential redirect risk; set in ~/.forge or FORGE_BASE_URL)",
    );
  }
  if (projectRaw.provider && projectRaw.provider !== globalCfg.provider) {
    console.error(
      "forge: ignoring project provider override (set in ~/.forge or FORGE_PROVIDER)",
    );
  }

  // blockingStopHooks: project may only force true (string "false"/"0" still blocked)
  {
    const b = coerceBool(projectRaw.blockingStopHooks);
    if (b === true) {
      cfg.blockingStopHooks = true;
    } else if (b === false) {
      console.error(
        "forge: ignoring project blocking_stop_hooks=false (set FORGE_BLOCKING_STOP=0 globally)",
      );
    }
  }

  return cfg;
}

/**
 * Load config with precedence (later wins, with deny-trust + project safety):
 * 1. DEFAULT_CONFIG
 * 2. ~/.forge/config.toml | config.json  (global)
 * 3. <cwd>/.forge/config.toml | config.json  (project — safe overlay only)
 * 4. ~/.forge/preferences.json  (last /model + /permissions + /effort — all sessions/folders)
 * 5. environment variables
 * 6. explicit CLI overrides
 */
export function loadConfig(overrides: Partial<ForgeConfig> = {}, cwd = process.cwd()): ForgeConfig {
  const home = forgeHome();
  const globalToml = loadToml(path.join(home, "config.toml"));
  const globalJson = loadJson(path.join(home, "config.json"));
  const projectToml = loadToml(path.join(cwd, ".forge", "config.toml"));
  const projectJson = loadJson(path.join(cwd, ".forge", "config.json"));

  // Merge without project first
  let globalMerged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    globalToml as never,
  ) as unknown as ForgeConfig;
  globalMerged = deepMerge(
    globalMerged as unknown as Record<string, unknown>,
    globalJson as never,
  ) as unknown as ForgeConfig;

  // Config-file provider goes through the same alias normalization as
  // FORGE_PROVIDER / CLI -p: provider = "grok" must resolve to xai, or
  // ENV_KEYS, stored accounts, and providers.* lookups all miss. Unknown
  // values pass through untouched (custom provider ids are allowed here).
  if (typeof globalMerged.provider === "string") {
    const norm = normalizeProviderId(globalMerged.provider);
    if (norm.ok) globalMerged.provider = norm.provider;
  }

  const globalPermission = {
    deny: globalMerged.permission?.deny ?? DEFAULT_CONFIG.permission.deny,
    allow: globalMerged.permission?.allow ?? [],
    ask: globalMerged.permission?.ask ?? [],
    rules: globalMerged.permission?.rules ?? [],
  };

  const projectRaw = deepMerge(
    projectToml as Record<string, unknown>,
    projectJson as never,
  ) as Partial<ForgeConfig>;

  let cfg = applySafeProjectOverlay(globalMerged, projectRaw);

  // Trusted permission merge
  const projectPermission = {
    deny: [
      ...((projectToml.permission as PermissionConfig | undefined)?.deny || []),
      ...((projectJson.permission as PermissionConfig | undefined)?.deny || []),
    ],
    allow: [
      ...((projectToml.permission as PermissionConfig | undefined)?.allow || []),
      ...((projectJson.permission as PermissionConfig | undefined)?.allow || []),
    ],
    ask: [
      ...((projectToml.permission as PermissionConfig | undefined)?.ask || []),
      ...((projectJson.permission as PermissionConfig | undefined)?.ask || []),
    ],
    rules: [
      ...((projectToml.permission as PermissionConfig | undefined)?.rules || []),
      ...((projectJson.permission as PermissionConfig | undefined)?.rules || []),
    ],
  };
  cfg.permission = mergePermissionTrust(
    globalPermission,
    projectPermission,
    DEFAULT_CONFIG.permission,
  );

  // Interactive preferences (slash /model, /permissions, /effort) — beat static config
  const prefs = loadPreferences();
  applyPreferences(cfg, prefs);

  // Environment overrides (invalid values ignored — parity with FORGE_EFFORT)
  const providerBeforeEnv = cfg.provider;
  if (process.env.FORGE_PROVIDER) {
    const norm = normalizeProviderId(process.env.FORGE_PROVIDER);
    if (norm.ok) cfg.provider = norm.provider;
  }
  if (process.env.FORGE_MODEL) cfg.model = process.env.FORGE_MODEL;
  if (process.env.FORGE_BASE_URL) cfg.baseUrl = process.env.FORGE_BASE_URL;
  {
    const effortRaw =
      process.env.FORGE_REASONING_EFFORT || process.env.FORGE_EFFORT;
    if (effortRaw) {
      const e = parseReasoningEffort(effortRaw);
      if (e) cfg.reasoningEffort = e;
    }
  }
  if (process.env.FORGE_PERMISSION_MODE) {
    const mode = normalizePermissionMode(process.env.FORGE_PERMISSION_MODE);
    if (mode) cfg.permissionMode = mode;
  }
  if (process.env.FORGE_SANDBOX) {
    const profile = normalizeSandboxProfile(process.env.FORGE_SANDBOX);
    if (profile) cfg.sandbox = profile;
  }
  if (process.env.FORGE_SANDBOX_NETWORK) {
    const net = normalizeSandboxNetwork(process.env.FORGE_SANDBOX_NETWORK);
    if (net) cfg.sandboxNetwork = net;
  }
  if (process.env.FORGE_SANDBOX_MISSING_BACKEND) {
    const miss = process.env.FORGE_SANDBOX_MISSING_BACKEND.trim() as SandboxMissingBackend;
    if (ENV_SANDBOX_MISSING.has(miss)) cfg.sandboxMissingBackend = miss;
  }
  if (process.env.FORGE_READ_OUTSIDE) {
    const ro = process.env.FORGE_READ_OUTSIDE.trim() as ReadOutsideWorkspace;
    if (ENV_READ_OUTSIDE.has(ro)) cfg.readOutsideWorkspace = ro;
  }
  if (process.env.FORGE_MAX_TURNS != null && process.env.FORGE_MAX_TURNS.trim() !== "") {
    const n = Number(process.env.FORGE_MAX_TURNS.trim());
    if (
      Number.isFinite(n) &&
      n >= 0 &&
      Math.floor(n) === n &&
      n <= 100_000
    ) {
      cfg.maxTurns = n;
    }
  }
  if (
    process.env.FORGE_MAX_COST_USD != null &&
    process.env.FORGE_MAX_COST_USD.trim() !== ""
  ) {
    // Lazy import avoided — parse inline to keep load.ts free of util cycles.
    const raw = process.env.FORGE_MAX_COST_USD.trim()
      .replace(/^\$/, "")
      .replace(/\s*usd\s*$/i, "")
      .trim();
    if (/^(off|none|unlimited|inf(inity)?)$/i.test(raw)) {
      cfg.maxCostUsd = 0;
    } else {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0 && n <= 1_000_000) {
        cfg.maxCostUsd = Math.round(n * 10_000) / 10_000;
      }
    }
  }
  if (process.env.FORGE_BLOCKING_STOP === "0") cfg.blockingStopHooks = false;
  if (process.env.FORGE_BLOCKING_STOP === "1") cfg.blockingStopHooks = true;
  if (process.env.FORGE_GOAL_GATE === "0") cfg.goal.enabled = false;
  if (process.env.FORGE_GOAL_STUCK_THRESHOLD) {
    // Positive only — 0 would disable stuck-wall release forever (footgun).
    // Invalid/0 ignored (keep config default), parity with FORGE_ULW_STUCK_THRESHOLD.
    const n = Number(process.env.FORGE_GOAL_STUCK_THRESHOLD.trim());
    if (Number.isFinite(n) && n >= 1) cfg.goal.stuckThreshold = Math.floor(n);
  }

  const modelExplicit =
    overrides.model != null || Boolean(process.env.FORGE_MODEL?.trim());
  // Model pinned by a config file or sticky prefs — a config-file provider
  // switch (below) must not clobber it. CLI/env provider switches still win
  // (existing rescue ignores these, by design).
  const fileModelExplicit =
    globalToml.model != null ||
    globalJson.model != null ||
    projectRaw.model != null ||
    Boolean(prefs.model);
  // providerBeforeEnv captured before FORGE_PROVIDER; after env, cfg.provider may already differ.
  const providerBaseline = providerBeforeEnv;
  cfg = deepMerge(cfg as unknown as Record<string, unknown>, overrides as never) as unknown as ForgeConfig;
  cfg.workspace = cfg.workspace ? path.resolve(cfg.workspace) : cwd;

  // Track whether context_window was explicitly chosen (file / project / CLI).
  // When not explicit, the window follows the active model (see below).
  cfg.contextWindowExplicit =
    globalToml.contextWindow != null ||
    globalJson.contextWindow != null ||
    projectRaw.contextWindow != null ||
    overrides.contextWindow != null;

  // Same tracking for max_tokens: when not explicit, the output budget
  // auto-resolves per model (larger for reasoning-active models).
  cfg.maxTokensExplicit =
    globalToml.maxTokens != null ||
    globalJson.maxTokens != null ||
    projectRaw.maxTokens != null ||
    overrides.maxTokens != null;

  // Provider switched (CLI/env) without an explicit model → that provider's defaultModel
  // (avoid anthropic + stuck grok-4.5 from DEFAULT_CONFIG.model).
  // A config-file provider (provider = "claude", no model anywhere) gets the
  // same rescue — but never clobbers a file/prefs-pinned model.
  const providerSwitched =
    cfg.provider !== providerBaseline ||
    (!fileModelExplicit && cfg.provider !== DEFAULT_CONFIG.provider);
  if (!modelExplicit && cfg.provider && providerSwitched) {
    const def = cfg.providers?.[cfg.provider]?.defaultModel;
    if (def) cfg.model = def;
    else if (!cfg.providers?.[cfg.provider]?.models?.length) {
      // Unknown/custom catalog — keep explicit-looking models only if user set FORGE_MODEL
      // otherwise use a neutral placeholder rather than another provider's id.
      cfg.model = "default";
    }
  }

  cfg.permission = {
    deny: cfg.permission?.deny ?? DEFAULT_CONFIG.permission.deny,
    allow: cfg.permission?.allow ?? [],
    ask: cfg.permission?.ask ?? [],
    rules: cfg.permission?.rules ?? [],
  };
  // Canonicalize file/override aliases so runtime gates match doctor/CI warnings.
  // Env already normalizes; global TOML/JSON previously left "yolo"/"none"/"false"
  // as raw strings (PermissionGate only honors bypassPermissions; sandbox only
  // honors off; hooks used !== false so stringy "false" stayed fail-closed while
  // doctor reported OFF).
  {
    const mode = normalizePermissionMode(cfg.permissionMode);
    if (mode) cfg.permissionMode = mode;
  }
  {
    const profile = normalizeSandboxProfile(cfg.sandbox);
    if (profile) cfg.sandbox = profile;
  }
  if (cfg.sandboxNetwork != null) {
    const net = normalizeSandboxNetwork(cfg.sandboxNetwork);
    if (net) cfg.sandboxNetwork = net;
  }
  {
    const b = coerceBool(cfg.blockingStopHooks as unknown);
    if (b !== undefined) cfg.blockingStopHooks = b;
  }
  if (!cfg.sandbox) cfg.sandbox = DEFAULT_CONFIG.sandbox;
  if (!cfg.sandboxMissingBackend) {
    cfg.sandboxMissingBackend = DEFAULT_CONFIG.sandboxMissingBackend;
  }
  if (!cfg.readOutsideWorkspace) {
    cfg.readOutsideWorkspace = DEFAULT_CONFIG.readOutsideWorkspace;
  }
  // Coerce string effort from TOML/JSON if still unparsed
  if (typeof (cfg as { reasoningEffort?: unknown }).reasoningEffort === "string") {
    const e = parseReasoningEffort(String(cfg.reasoningEffort));
    cfg.reasoningEffort = e ?? undefined;
  }

  // Effort: default is each model's maximum allowed level (resolved at request
  // time when reasoningEffort is undefined). Explicit CLI/env/toml keeps a pin;
  // when the user only switched model/provider via CLI without --effort, drop
  // sticky prefs effort so we don't keep grok "high" under DeepSeek (which can
  // go to "max").
  const effortExplicit =
    globalToml.reasoningEffort != null ||
    globalJson.reasoningEffort != null ||
    projectRaw.reasoningEffort != null ||
    overrides.reasoningEffort != null ||
    Boolean(
      process.env.FORGE_REASONING_EFFORT?.trim() ||
        process.env.FORGE_EFFORT?.trim(),
    );
  if (!effortExplicit && modelExplicit) {
    cfg.reasoningEffort = undefined;
  } else if (cfg.reasoningEffort) {
    const clamped = clampEffortForModel(cfg.model, cfg.reasoningEffort);
    if (clamped) cfg.reasoningEffort = clamped;
  }

  // Per-model context window unless the user pinned context_window: a stale
  // 500k budget on a 131k/256k model means the provider rejects overflow long
  // before auto-compact would fire. Uses static table + OpenRouter cache.
  if (!cfg.contextWindowExplicit) {
    const win = modelContextWindow(cfg.model);
    if (win) cfg.contextWindow = win;
  }
  return cfg;
}

export function defaultConfigToml(): string {
  return `# Forge agent config — ~/.forge/config.toml
# Docs: docs/SAFETY.md · docs/PRODUCTION.md · docs/RELIABILITY.md

provider = "xai"
model = "grok-4.5"
# low | medium | high  (only sent for models that support it, e.g. grok-4.5)
# Omit for model max (recommended). Pin with low|medium|high|max when needed:
# reasoning_effort = "max"
# temperature: unset = provider/server default (recommended — reasoning models
# are tuned for it; DeepSeek thinking ignores temperature). Pin to override:
# temperature = 0.2
# max_tokens: unset = auto (16k non-reasoning · 32k–64k reasoning-active, so
# high-effort thinking is not truncated mid-thought). Pin to override:
# max_tokens = 16384
max_turns = 0                 # 0 = unlimited; set e.g. 200 to cap agent turns
max_cost_usd = 0              # 0 = unlimited; set e.g. 5 to release when session est. hits $5
permission_mode = "default"  # default | acceptEdits | plan | bypassPermissions | dontAsk

# OS sandbox for bash (macOS: sandbox-exec, Linux: bwrap)
# off | workspace | read-only | strict
sandbox = "workspace"
# unrestricted | blocked  (unset: workspace=open, read-only/strict=blocked)
# sandbox_network = "unrestricted"
# fail-closed (default) | fallback
sandbox_missing_backend = "fail-closed"
# ask | allow | deny — file/path access outside workspace
read_outside_workspace = "ask"

# Harness: keep true for production (Stop hooks can force continue)
blocking_stop_hooks = true
compat_claude_hooks = true
compat_cursor_hooks = true

# Context: auto-compact when estimated tokens exceed this fraction of context_window
# auto_compact_threshold = 0.80
# context_window defaults to the active model's real max (auto). OpenRouter
# models use static table + cached context_length (forge models -p openrouter).
# Pin only when you want a smaller/larger budget than the model max:
# context_window = 500000

[goal]
enabled = true
stuck_threshold = 3
auto_arm = true

# Permission rules — deny always wins (including YOLO)
# Project .forge/config.toml may only ADD deny rules, never remove global ones.
# Project cannot set: base_url, bypassPermissions, sandbox=off, missing-backend fallback.
[permission]
deny = [
  "Bash(rm -rf /)",
  "Bash(rm -fr /)",
  "Bash(rm -rf ~)",
  "Bash(git push --force *main*)",
]
allow = []
ask = []

# Optional per-provider overrides (global ~/.forge only — not project)
# [providers.xai]
# base_url = "https://api.x.ai/v1"
# Env: FORGE_PROVIDER_TIMEOUT_MS, FORGE_MAX_RUN_MS, FORGE_LOG_JSON, FORGE_HEADLESS — see .env.example
# MCP: built-in defaults context7 + playwright (see ~/.forge/mcp.json). FORGE_MCP=0 off;
# FORGE_MCP_DEFAULTS=0 disables only built-ins. Optional CONTEXT7_API_KEY for higher rate limits.
`;
}
