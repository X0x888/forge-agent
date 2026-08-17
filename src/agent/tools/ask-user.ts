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
import { enqueuePrompt } from "../permissions.js";
import { withStdinLease } from "../../tui/stdin-lease.js";
import { clipAnsi, visibleWidth } from "../../util/format.js";

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

  return enqueuePrompt(() => withStdinLease(() => promptAskUser(question, choices, context)));
}

/** Card above the readline — question + numbered choices, no lecture. */
export function formatAskUserCard(
  question: string,
  choices: string[],
  context: string,
): string {
  const lines: string[] = [chalk.cyan(`❓ ${question}`)];
  if (context) lines.push(chalk.dim(`  ${context}`));
  if (choices.length) {
    const bits = choices.map((c, i) => `${i + 1}) ${c}`);
    const inline = bits.join("  ");
    // One row when it fits an 80-col TTY; otherwise stack so keys stay visible.
    if (inline.length <= 76) {
      lines.push(chalk.dim(`  ${inline}`));
    } else {
      for (const bit of bits) lines.push(chalk.dim(`  ${bit}`));
    }
  }
  return lines.join("\n");
}

export type AskUserMatch =
  | { kind: "skip" }
  | { kind: "choice"; index: number }
  | { kind: "text"; value: string };

/**
 * Allow?-style keys under the card. Choices already list 1) 2) — the
 * prompt is just what to type, not a grammar lecture.
 */
export function formatAskUserPrompt(
  choices: string[],
  opts?: { timeoutNote?: string; columns?: number },
): string {
  const n = choices.length;
  const keys = n
    ? `Ask? 1–${n} · letter · text · ↵ skip`
    : `Ask? text · ↵ skip`;
  const note = (opts?.timeoutNote ?? "").trim();
  const line = `${keys}${note ? ` ${note}` : ""} `;
  const cols = Math.max(
    8,
    opts?.columns ??
      (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  if (visibleWidth(line) <= cols) return line;
  return wrapAskUserPromptLine(line, cols);
}

/** Pack Ask? keys onto as few rows as fit; last row keeps a trailing space. */
export function wrapAskUserPromptLine(line: string, cols: number): string {
  const caret = "Ask? ";
  const body = line.startsWith(caret) ? line.slice(caret.length) : line;
  const tokens = body
    .split(" · ")
    .map((t) => t.trim())
    .filter(Boolean);
  const rows: string[] = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current
      ? `${current} · ${token}`
      : rows.length === 0
        ? `${caret}${token}`
        : `  · ${token}`;
    if (visibleWidth(candidate) <= cols) {
      current = candidate;
      continue;
    }
    if (current) {
      rows.push(current);
      current = "";
    }
    const alone = rows.length === 0 ? `${caret}${token}` : `  · ${token}`;
    current = visibleWidth(alone) <= cols ? alone : clipAnsi(alone, cols);
  }
  if (current) rows.push(current);
  if (!rows.length) return line;
  const last = rows[rows.length - 1]!;
  if (visibleWidth(last) < cols) rows[rows.length - 1] = `${last} `;
  return rows.join("\n");
}

/**
 * Parse a typed answer. Prefer a unique choice (index, exact, prefix, first
 * letter) over free text so `y`/`n` and short prefixes actually pick.
 */
export function matchAskUserAnswer(raw: string, choices: string[]): AskUserMatch {
  const ans = raw.trim();
  if (!ans || /^skip$/i.test(ans) || /^cancel$/i.test(ans)) {
    return { kind: "skip" };
  }
  if (choices.length && /^\d+$/.test(ans)) {
    const idx = Number(ans) - 1;
    if (idx >= 0 && idx < choices.length) return { kind: "choice", index: idx };
    return { kind: "text", value: ans };
  }
  if (choices.length) {
    const lower = ans.toLowerCase();
    const exact = choices.findIndex((c) => c.toLowerCase() === lower);
    if (exact >= 0) return { kind: "choice", index: exact };
    const prefixes = choices
      .map((c, i) => ({ i, c: c.toLowerCase() }))
      .filter(({ c }) => c.startsWith(lower) && c.length > lower.length);
    if (prefixes.length === 1) return { kind: "choice", index: prefixes[0]!.i };
    if (lower.length === 1) {
      const letters = choices
        .map((c, i) => ({ i, c: c.toLowerCase() }))
        .filter(({ c }) => c.startsWith(lower));
      if (letters.length === 1) return { kind: "choice", index: letters[0]!.i };
    }
  }
  return { kind: "text", value: ans };
}

async function promptAskUser(
  question: string,
  choices: string[],
  context: string,
): Promise<ToolResult> {
  console.error(formatAskUserCard(question, choices, context));

  const timeoutMs = askTimeoutMs();
  const timeoutNote =
    timeoutMs > 0
      ? chalk.dim(`· ${Math.round(timeoutMs / 1000)}s`)
      : "";
  const rl = readline.createInterface({
    input: stdinStream,
    output: stdoutStream,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const prompt = formatAskUserPrompt(choices, { timeoutNote });
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

    const hit = matchAskUserAnswer(ansRaw, choices);
    if (hit.kind === "skip") {
      return {
        output:
          "User skipped the question. Do not block — state your best assumption and continue, or ask a narrower question later.",
      };
    }
    if (hit.kind === "choice") {
      return {
        output: `User chose option ${hit.index + 1}: ${choices[hit.index]}`,
      };
    }
    return {
      output: `User answered: ${hit.value.slice(0, 2000)}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
    rl.close();
  }
}
