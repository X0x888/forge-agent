/**
 * Interactive unauthenticated TTY login offer.
 * Headless / --json / non-TTY stay fail-closed (caller skips this).
 */
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loginInteractive, type LoginMethod } from "../auth/login.js";
import { normalizeProviderId } from "../util/provider-id.js";
import { log } from "../util/log.js";

export type LoginOfferChoice =
  | { kind: "oauth"; provider: string }
  | { kind: "api_key"; provider: string }
  | { kind: "provider"; provider: string }
  | { kind: "env" }
  | { kind: "quit" };

export function shouldOfferLoginPicker(opts: {
  json?: boolean;
  headless?: boolean;
  isTty?: boolean;
}): boolean {
  if (opts.json) return false;
  if (opts.headless) return false;
  const env = (process.env.FORGE_HEADLESS || "").trim().toLowerCase();
  if (env === "1" || env === "true" || env === "yes") return false;
  return Boolean(opts.isTty);
}

export function formatLoginOffer(): string {
  return [
    "⚒  Forge  ·  not signed in",
    "",
    "  1) forge login          SuperGrok / X Premium (browser)",
    "  2) forge login --api-key",
    "  3) forge login -p anthropic|openai|openrouter|copilot",
    "  4) set XAI_API_KEY / ANTHROPIC_API_KEY / …",
    "",
    "  Run which? [1]  ·  q to quit  ·  Enter = 1",
  ].join("\n");
}

export function parseLoginOfferChoice(raw: string): LoginOfferChoice {
  const s = String(raw || "").trim().toLowerCase();
  if (!s || s === "1" || s === "login" || s === "oauth" || s === "browser") {
    return { kind: "oauth", provider: "xai" };
  }
  if (
    s === "2" ||
    s === "api" ||
    s === "api-key" ||
    s === "key" ||
    s === "apikey"
  ) {
    return { kind: "api_key", provider: "xai" };
  }
  if (s === "3" || s === "p" || s === "provider" || s === "other") {
    return { kind: "provider", provider: "" };
  }
  if (s.startsWith("3 ") || s.startsWith("-p ") || s.startsWith("p ")) {
    const rest = s.replace(/^3\s+/, "").replace(/^-p\s+/, "").replace(/^p\s+/, "");
    return { kind: "provider", provider: rest };
  }
  if (
    s === "4" ||
    s === "env" ||
    s === "key-env" ||
    s === "export"
  ) {
    return { kind: "env" };
  }
  if (s === "q" || s === "quit" || s === "exit" || s === "n" || s === "no") {
    return { kind: "quit" };
  }
  // `anthropic` / `openai` typed directly
  const parsed = normalizeProviderId(s);
  if (parsed.ok) {
    return parsed.provider === "xai"
      ? { kind: "oauth", provider: "xai" }
      : { kind: "provider", provider: parsed.provider };
  }
  return { kind: "quit" };
}

export const LOGIN_ENV_HINT =
  "Set an API key env var, then re-run forge:\n" +
  "  XAI_API_KEY  ·  ANTHROPIC_API_KEY  ·  OPENAI_API_KEY  ·  OPENROUTER_API_KEY  ·  DEEPSEEK_API_KEY";

/**
 * Prompt + run loginInteractive. Returns true when credentials should now resolve.
 */
export async function offerLoginInteractive(): Promise<boolean> {
  console.log("");
  console.log(formatLoginOffer());
  const rl = readline.createInterface({ input, output });
  let answer: string;
  try {
    answer = await rl.question("  > ");
  } finally {
    rl.close();
  }
  const choice = parseLoginOfferChoice(answer);
  if (choice.kind === "quit") return false;
  if (choice.kind === "env") {
    console.log("");
    console.log(LOGIN_ENV_HINT);
    return false;
  }

  let provider = choice.provider || "xai";
  let method: LoginMethod | undefined =
    choice.kind === "api_key"
      ? "api_key"
      : choice.kind === "oauth"
        ? "oauth"
        : undefined;

  if (choice.kind === "provider" && !choice.provider) {
    const rl2 = readline.createInterface({ input, output });
    let p: string;
    try {
      p = (
        await rl2.question(
          "  Provider [anthropic|openai|openrouter|copilot|xai]: ",
        )
      ).trim();
    } finally {
      rl2.close();
    }
    if (!p) return false;
    const parsed = normalizeProviderId(p);
    provider = parsed.ok ? parsed.provider : p.toLowerCase();
  }

  try {
    await loginInteractive({ provider, method });
    log.info("Next: forge   ·   forge setup   ·   forge doctor");
    return true;
  } catch (err) {
    log.error((err as Error).message || String(err));
    return false;
  }
}
