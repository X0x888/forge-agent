/**
 * Interactive clarifying question (OpenCode question-tool inspired).
 *
 * Experts use this when requirements are ambiguous instead of guessing.
 * Headless / non-TTY: fail closed with guidance to state assumptions.
 */
import readline from "node:readline/promises";
import { stdin as stdinStream, stdout as stdoutStream } from "node:process";
import chalk from "chalk";
import type { ToolResult } from "./types.js";

export type AskUserInput = {
  question: string;
  /** Optional multiple-choice options (1-based when prompting). */
  choices?: string[];
  /** Optional short context for the user. */
  context?: string;
};

function isInteractiveTty(): boolean {
  if (process.env.FORGE_HEADLESS === "1" || process.env.FORGE_HEADLESS === "true") {
    return false;
  }
  if (process.env.FORGE_DONT_ASK === "1" || process.env.FORGE_DONT_ASK === "true") {
    return false;
  }
  return Boolean(stdinStream.isTTY && stdoutStream.isTTY);
}

function askTimeoutMs(): number {
  const raw = process.env.FORGE_ASK_USER_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === "") {
    // Default 5 minutes — clarifying questions can wait longer than permission asks.
    return 300_000;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 300_000;
  return Math.floor(n);
}

export async function toolAskUser(input: AskUserInput): Promise<ToolResult> {
  const question = String(input.question || "").trim();
  if (!question) {
    return {
      output:
        "ask_user error: question is required (non-empty string).\n" +
        'Example: { "question": "Ship the migration now, or wait for review?", "choices": ["ship now", "wait"] }\n' +
        "Whitespace-only questions fail closed. Prefer ask_user for ambiguous/destructive choices — do not guess.",
      isError: true,
    };
  }
  if (question.length > 2000) {
    return {
      output: "ask_user question too long (max 2000 chars).",
      isError: true,
    };
  }

  const choices = (input.choices || [])
    .filter((c) => typeof c === "string" && c.trim())
    .map((c) => c.trim().slice(0, 200))
    .slice(0, 12);
  const context = String(input.context || "").trim().slice(0, 500);

  if (!isInteractiveTty()) {
    return {
      output:
        "ask_user unavailable in headless/non-interactive mode. " +
        "State your best assumption explicitly and continue, or re-run interactively. " +
        (choices.length
          ? `Suggested choices were: ${choices.map((c, i) => `${i + 1}) ${c}`).join("; ")}`
          : `Question was: ${question}`),
      isError: true,
    };
  }

  const lines: string[] = [
    "",
    chalk.cyan("❓ Agent question"),
  ];
  if (context) lines.push(chalk.dim(`  context: ${context}`));
  lines.push(chalk.bold(`  ${question}`));
  if (choices.length) {
    for (let i = 0; i < choices.length; i++) {
      lines.push(chalk.dim(`    ${i + 1}) ${choices[i]}`));
    }
    lines.push(
      chalk.dim(
        "  Reply with a number, free text, or 'skip' to decline.",
      ),
    );
  } else {
    lines.push(chalk.dim("  Reply with free text, or 'skip' to decline."));
  }
  console.error(lines.join("\n"));

  const timeoutMs = askTimeoutMs();
  const timeoutNote =
    timeoutMs > 0
      ? chalk.dim(` (timeout ${Math.round(timeoutMs / 1000)}s)`)
      : "";
  const rl = readline.createInterface({
    input: stdinStream,
    output: stdoutStream,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const prompt = choices.length
      ? `Your answer [1-${choices.length} / text / skip]:${timeoutNote} `
      : `Your answer [text / skip]:${timeoutNote} `;
    const questionP = rl.question(prompt);
    const ansRaw = (
      await (timeoutMs > 0
        ? Promise.race([
            questionP,
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve("__timeout__"), timeoutMs);
              timer.unref?.();
            }),
          ])
        : questionP)
    ).trim();

    if (ansRaw === "__timeout__") {
      return {
        output:
          `ask_user timed out after ${Math.round(timeoutMs / 1000)}s — user did not answer. ` +
          `State a reasonable assumption and continue, or raise FORGE_ASK_USER_TIMEOUT_MS.`,
        isError: true,
      };
    }

    const ans = ansRaw;
    if (!ans || /^skip$/i.test(ans) || /^cancel$/i.test(ans)) {
      return {
        output:
          "User skipped the question. Do not block — state your best assumption and continue, or ask a narrower question later.",
      };
    }

    // Numeric choice
    if (choices.length && /^\d+$/.test(ans)) {
      const idx = Number(ans) - 1;
      if (idx >= 0 && idx < choices.length) {
        return {
          output: `User chose option ${idx + 1}: ${choices[idx]}`,
        };
      }
      return {
        output: `User answered "${ans}" (not a valid choice index 1-${choices.length}). Treat as free text.`,
      };
    }

    // Match choice by exact/prefix text
    if (choices.length) {
      const lower = ans.toLowerCase();
      const exact = choices.findIndex((c) => c.toLowerCase() === lower);
      if (exact >= 0) {
        return {
          output: `User chose option ${exact + 1}: ${choices[exact]}`,
        };
      }
    }

    return {
      output: `User answered: ${ans.slice(0, 2000)}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
    rl.close();
  }
}
