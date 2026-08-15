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
  | { kind: "quit" }
  | { kind: "invalid"; input: string };

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
    "⚒  Forge  ·  not signed in  ·  type 1–4 (Enter = 1)",
    "",
    "  1) SuperGrok / X Premium (browser)",
    "  2) Paste an API key",
    "  3) Other provider (anthropic, openai, openrouter, copilot)",
    "  4) Use env vars already set",
    "",
    "  q quits  ·  a provider name works too",
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
  return { kind: "invalid", input: String(raw ?? "").trim() };
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
  try {
    while (true) {
      const answer = await rl.question("  > ");
      const choice = parseLoginOfferChoice(answer);
      if (choice.kind === "invalid") {
        console.log(
          `  Unknown "${choice.input}". Type 1–4, a provider name, or q.`,
        );
        continue;
      }
      if (choice.kind === "quit") return false;
      if (choice.kind === "env") {
        console.log("");
        console.log(LOGIN_ENV_HINT);
        return false;
      }

      let provider = choice.provider || "xai";
      const method: LoginMethod | undefined =
        choice.kind === "api_key"
          ? "api_key"
          : choice.kind === "oauth"
            ? "oauth"
            : undefined;

      if (choice.kind === "provider" && !choice.provider) {
        const p = (
          await rl.question(
            "  Provider [anthropic|openai|openrouter|copilot|xai]: ",
          )
        ).trim();
        if (!p) {
          console.log("  Need a provider name, or q to quit.");
          continue;
        }
        const parsed = normalizeProviderId(p);
        if (!parsed.ok) {
          console.log(
            `  Unknown provider "${p}". Try anthropic, openai, openrouter, copilot, or xai.`,
          );
          continue;
        }
        provider = parsed.provider;
      }

      try {
        await loginInteractive({ provider, method });
        log.info("Signed in. Type a task in English, or /setup to finish settings.");
        return true;
      } catch (err) {
        log.error((err as Error).message || String(err));
        console.log("  Try 1–4 again, or q to quit.");
        continue;
      }
    }
  } finally {
    rl.close();
  }
}
