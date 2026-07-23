import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = (process.env.FORGE_LOG_LEVEL as LogLevel) || "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

export const log = {
  debug(msg: string, ...args: unknown[]): void {
    if (enabled("debug")) console.error(chalk.gray(`[debug] ${msg}`), ...args);
  },
  info(msg: string, ...args: unknown[]): void {
    if (enabled("info")) console.error(chalk.cyan(`ℹ ${msg}`), ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    if (enabled("warn")) console.error(chalk.yellow(`⚠ ${msg}`), ...args);
  },
  error(msg: string, ...args: unknown[]): void {
    if (enabled("error")) console.error(chalk.red(`✖ ${msg}`), ...args);
  },
  success(msg: string, ...args: unknown[]): void {
    if (enabled("info")) console.error(chalk.green(`✔ ${msg}`), ...args);
  },
  dim(msg: string): void {
    if (enabled("info")) console.error(chalk.dim(msg));
  },
};
