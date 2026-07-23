import type { ForgeConfig } from "../config/types.js";
import type { ResolvedAuth } from "../auth/types.js";
import type { LLMProvider } from "./types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { AnthropicProvider } from "./anthropic.js";

export function createProvider(config: ForgeConfig, auth: ResolvedAuth): LLMProvider {
  const provider = auth.provider;
  const pcfg = config.providers[provider];
  const baseUrl = auth.baseUrl ?? pcfg?.baseUrl ?? config.baseUrl ?? "https://api.openai.com/v1";

  if (provider === "anthropic") {
    return new AnthropicProvider({ baseUrl, apiKey: auth.token });
  }

  const extraHeaders: Record<string, string> = {};
  if (provider === "openrouter") {
    extraHeaders["HTTP-Referer"] = "https://github.com/forge-agent/forge";
    extraHeaders["X-Title"] = "Forge Agent CLI";
  }

  return new OpenAICompatProvider({
    id: provider,
    baseUrl,
    apiKey: auth.token,
    extraHeaders,
  });
}
