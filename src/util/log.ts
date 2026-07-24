import chalk from "chalk";

// Honor NO_COLOR / non-TTY for expert CI pipelines (chalk v5 usually does,
// but force-disable when NO_COLOR is set so JSON mode stays pure).
if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") {
  // chalk reads this; keep explicit for clarity
  process.env.FORCE_COLOR = process.env.FORCE_COLOR || "0";
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = (process.env.FORGE_LOG_LEVEL as LogLevel) || "info";

/** Machine-readable logs for CI (FORGE_LOG_JSON=1). Always on stderr. */
function jsonMode(): boolean {
  const v = process.env.FORGE_LOG_JSON?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function emitJson(level: string, msg: string, args: unknown[]): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    entry.data = args[0];
  } else if (args.length) {
    entry.data = args.map((a) => {
      if (a instanceof Error) return { name: a.name, message: a.message };
      return a;
    });
  }
  console.error(JSON.stringify(entry));
}

function formatExtra(args: unknown[]): string {
  if (!args.length) return "";
  try {
    return (
      " " +
      args
        .map((a) =>
          typeof a === "string"
            ? a
            : a instanceof Error
              ? a.message
              : JSON.stringify(a),
        )
        .join(" ")
    );
  } catch {
    return "";
  }
}

export const log = {
  debug(msg: string, ...args: unknown[]): void {
    if (!enabled("debug")) return;
    if (jsonMode()) emitJson("debug", msg, args);
    else console.error(chalk.gray(`[debug] ${msg}`) + formatExtra(args));
  },
  info(msg: string, ...args: unknown[]): void {
    if (!enabled("info")) return;
    if (jsonMode()) emitJson("info", msg, args);
    else console.error(chalk.cyan(`ℹ ${msg}`) + formatExtra(args));
  },
  warn(msg: string, ...args: unknown[]): void {
    if (!enabled("warn")) return;
    if (jsonMode()) emitJson("warn", msg, args);
    else console.error(chalk.yellow(`⚠ ${msg}`) + formatExtra(args));
  },
  error(msg: string, ...args: unknown[]): void {
    if (!enabled("error")) return;
    if (jsonMode()) emitJson("error", msg, args);
    else console.error(chalk.red(`✖ ${msg}`) + formatExtra(args));
  },
  success(msg: string, ...args: unknown[]): void {
    if (!enabled("info")) return;
    if (jsonMode()) emitJson("info", msg, args);
    else console.error(chalk.green(`✔ ${msg}`) + formatExtra(args));
  },
  dim(msg: string): void {
    if (!enabled("info")) return;
    if (jsonMode()) emitJson("info", msg, []);
    else console.error(chalk.dim(msg));
  },
};
