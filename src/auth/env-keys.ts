/**
 * Env var names that hold Forge LLM / provider credentials.
 * Shared by auth resolve, multi-account, and child-env scrub so MCP/LSP
 * `keepSecrets` cannot inherit XAI_API_KEY / CURSOR_ACCESS_TOKEN while
 * still passing GITHUB_TOKEN.
 */

/** Canonical provider-id → credential env names (auto-detect order). */
export const PROVIDER_API_KEY_ENV: Record<string, readonly string[]> = {
  xai: ["XAI_API_KEY", "GROK_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  // GitHub OAuth tokens for Copilot exchange (not raw Copilot session tokens)
  copilot: [
    "COPILOT_GITHUB_TOKEN",
    "GITHUB_COPILOT_TOKEN",
    "GH_COPILOT_TOKEN",
  ],
  cursor: ["CURSOR_API_KEY", "CURSOR_ACCESS_TOKEN"],
  custom: ["FORGE_API_KEY"],
};

const PROVIDER_ENV_ALIASES: Record<string, string> = {
  grok: "xai",
  codex: "openai",
  ds: "deepseek",
  github: "copilot",
  "github-copilot": "copilot",
  "cursor-ai": "cursor",
  cursorai: "cursor",
};

/** Always treated as a Forge credential, any provider. */
export const FORGE_API_KEY_ENV = "FORGE_API_KEY";

const PROVIDER_API_KEY_ENV_LOWER = new Set<string>(
  [
    FORGE_API_KEY_ENV,
    ...Object.values(PROVIDER_API_KEY_ENV).flat(),
  ].map((s) => s.toLowerCase()),
);

/** Map CLI / alias provider ids onto the ENV table key. */
export function resolveProviderEnvId(provider: string): string {
  const p = String(provider || "").toLowerCase();
  return PROVIDER_ENV_ALIASES[p] ?? p;
}

/**
 * True when `name` is a Forge/LLM provider credential env var.
 * Case-insensitive. Used by createChildEnv keepSecrets — still stripped
 * from inherit; policy `set` (mcp.json env) can reintroduce.
 */
export function isProviderApiKeyEnv(name: string): boolean {
  return PROVIDER_API_KEY_ENV_LOWER.has(name.toLowerCase());
}

/** Env names that count as "env auth" for a provider (includes FORGE_API_KEY). */
export function providerApiKeyEnvNames(provider: string): string[] {
  const id = resolveProviderEnvId(provider);
  const listed = PROVIDER_API_KEY_ENV[id] ?? [];
  const out = [FORGE_API_KEY_ENV];
  for (const n of listed) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Provider-specific credential names only (no shared FORGE_API_KEY unless custom). */
export function providerOwnApiKeyEnvNames(provider: string): string[] {
  const id = resolveProviderEnvId(provider);
  return [...(PROVIDER_API_KEY_ENV[id] ?? [])];
}

export function allProviderApiKeyEnvNames(): string[] {
  return [...PROVIDER_API_KEY_ENV_LOWER].sort();
}
