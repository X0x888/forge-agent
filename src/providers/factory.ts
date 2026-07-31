import type { ForgeConfig } from "../config/types.js";
import type { ResolvedAuth } from "../auth/types.js";
import type { LLMProvider } from "./types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { AnthropicProvider } from "./anthropic.js";
import {
  COPILOT_API_BASE,
  copilotApiHeaders,
} from "../auth/copilot.js";

export function createProvider(config: ForgeConfig, auth: ResolvedAuth): LLMProvider {
  const provider = auth.provider;
  const pcfg = config.providers[provider];
  const baseUrl = auth.baseUrl ?? pcfg?.baseUrl ?? config.baseUrl;

  if (provider === "anthropic") {
    // No shared OpenAI fallback here — AnthropicProvider defaults to
    // https://api.anthropic.com/v1 when nothing is configured.
    return new AnthropicProvider({ baseUrl, apiKey: auth.token });
  }

  const extraHeaders: Record<string, string> = {};
  if (provider === "openrouter") {
    extraHeaders["HTTP-Referer"] = "https://github.com/X0x888/forge-agent";
    extraHeaders["X-Title"] = "Forge Agent CLI";
  }
  if (provider === "copilot") {
    Object.assign(extraHeaders, copilotApiHeaders());
  }

  return new OpenAICompatProvider({
    id: provider,
    baseUrl:
      provider === "copilot"
        ? auth.baseUrl ?? pcfg?.baseUrl ?? COPILOT_API_BASE
        : baseUrl ?? "https://api.openai.com/v1",
    apiKey: auth.token,
    extraHeaders,
  });
}
