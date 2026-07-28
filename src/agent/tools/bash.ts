import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolContext, ToolResult } from "./types.js";
import { createShellEnv } from "./env-policy.js";
import { boundToolOutput, BASH_MAX_CHARS } from "./truncate.js";
import { startBackgroundTask } from "./background-tasks.js";
import {
  defaultBashBackgroundTimeoutMs,
  defaultBashTimeoutMs,
} from "../../util/env.js";
import { isTruthy } from "../../util/bool.js";
import { numberFieldError } from "./arg-types.js";
import { editDistance } from "../../util/string-distance.js";
import { parseDurationMs } from "../../util/duration-ms.js";

const execAsync = promisify(exec);

/** Parse timeout_ms: omitted → fallback; explicit invalid → null (fail closed). */
function resolveTimeoutMs(
  raw: unknown,
  fallback: number,
): { ok: true; ms: number } | { ok: false; tip?: string } {
  if (raw == null || String(raw).trim() === "") return { ok: true, ms: fallback };
  const key = String(raw).trim().toLowerCase();
  if (key === "default" || key === "def" || key === "auto" || key === "omit") {
    return { ok: true, ms: fallback };
  }
  // max/all/unlimited → 30 minutes (safety ceiling for long jobs)
  if (key === "max" || key === "unlimited" || key === "full" || key === "all") {
    return { ok: true, ms: Math.max(fallback, 30 * 60 * 1000) };
  }
  // Duration suffixes: 30s, 1m, 2h, 500ms (expert muscle memory).
  const parsedDur = parseDurationMs(key);
  if (parsedDur.ok && !/^\d+$/.test(key)) {
    // Cap absurd values at 24h
    return { ok: true, ms: Math.min(parsedDur.ms, 24 * 60 * 60 * 1000) };
  }
  if (!/^\d+$/.test(key)) {
    let tip: string | undefined;
    let best = Infinity;
    for (const c of ["default", "max", "all", "30s", "1m", "30000", "60000", "120000"]) {
      const d = editDistance(key, c);
      if (d < best && d <= Math.max(2, Math.floor(c.length / 2))) {
        best = d;
        tip = c;
      }
    }
    return tip ? { ok: false, tip } : { ok: false };
  }
  const n = Number(key);
  if (!Number.isFinite(n) || n < 1) return { ok: false };
  return { ok: true, ms: Math.floor(n) };
}

export async function toolBash(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Trim so whitespace-only is rejected (was a silent no-op success).
  if (args.command != null && typeof args.command !== "string") {
    const kind =
      args.command === null
        ? "null"
        : Array.isArray(args.command)
          ? "array"
          : typeof args.command;
    return {
      output: `bash error: command must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const command = String(args.command || "").trim();
  if (!command) {
    return {
      output:
        "bash error: command is required (non-empty string).\n" +
        'Example: { "command": "npm test", "timeout_ms": "120s" }\n' +
        "For long jobs: { \"command\": \"npm run build\", \"background\": true } then get_task_output.",
      isError: true,
    };
  }
  const timeoutRes = resolveTimeoutMs(args.timeout_ms, defaultBashTimeoutMs());
  if (!timeoutRes.ok) {
    return {
      output:
        numberFieldError(
          "bash",
          "timeout_ms",
          args.timeout_ms,
          (timeoutRes.tip ? `Did you mean: ${timeoutRes.tip}? ` : "") +
            "Pass a positive integer ms (or 30s/1m/2h), or default|max|all (omit for default).",
        ),
      isError: true,
    };
  }
  const timeout = timeoutRes.ms;
  const profile = ctx.sandbox ?? "workspace";
  const missingBackend = ctx.sandboxMissingBackend ?? "fail-closed";
  const env = createShellEnv(process.env);

  if (isTruthy(args.background) || isTruthy(args.run_in_background)) {
    const bgTimeoutRes = resolveTimeoutMs(
      args.timeout_ms,
      defaultBashBackgroundTimeoutMs(),
    );
    if (!bgTimeoutRes.ok) {
      return {
        output:
          numberFieldError(
            "bash",
            "timeout_ms",
            args.timeout_ms,
            (bgTimeoutRes.tip ? `Did you mean: ${bgTimeoutRes.tip}? ` : "") +
              "Pass a positive integer ms (or 30s/1m/2h), or default|max|all (omit for default).",
          ),
        isError: true,
      };
    }
    const bgTimeoutMs = bgTimeoutRes.ms;
  const started = await startBackgroundTask({
      command,
      cwd: ctx.workspace,
      profile,
      network: ctx.sandboxNetwork,
      missingBackend,
      timeoutMs: bgTimeoutMs,
    });
    if (!started.ok) {
      return {
        output: started.message,
        isError: true,
      };
    }
  const t = started.task;
    const bgTimeout = bgTimeoutMs;
    return {
      output:
        `Background task started.\n` +
        `task_id: ${t.id}\n` +
        `pid: ${t.pid ?? "n/a"}\n` +
        `timeout_ms: ${bgTimeout}\n` +
        `sandbox: ${t.backend}${t.sandboxed ? "" : " (unsandboxed)"}\n` +
        `stdout: ${t.stdoutPath}\n` +
        `stderr: ${t.stderrPath}\n` +
        `Use get_task_output with this task_id to poll; kill_task to stop.`,
    };
  }

  try {
    const { execCommandSandboxed } = await import("./sandbox-exec.js");
    if (ctx.signal?.aborted) {
      return { output: "Aborted", isError: true };
    }
  const result = await execCommandSandboxed({
      command,
      cwd: ctx.workspace,
      timeoutMs: timeout,
      profile,
      network: ctx.sandboxNetwork,
      missingBackend,
      env,
      signal: ctx.signal,
    });
    if (result.failClosed) {
      const managed = await boundToolOutput(
        result.stderr ||
          "Sandbox backend unavailable (fail-closed). Install bwrap / Xcode CLT, or set sandbox=off.",
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text, isError: true };
    }
    if (ctx.signal?.aborted || result.code === 130) {
      const managed = await boundToolOutput(
        result.stderr || "Aborted",
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text, isError: true };
    }
  const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const net = result.network ? ` net=${result.network}` : "";
    const meta = result.sandboxed
      ? `[sandbox:${result.backend}${net}] `
      : result.warning
        ? `[sandbox:off — ${result.warning}] `
        : "";
    if (result.code && result.code !== 0) {
      // Always surface exit code — models often miss it when stderr is noisy.
      // 124 = wall-clock timeout (sandbox runner convention).
      const timeoutNote =
        result.code === 124 && !/timed out/i.test(out)
          ? `\nCommand timed out after ${timeout}ms`
          : "";
      const body = out
        ? `${out}${timeoutNote}\n\n[exit code ${result.code}]`
        : result.code === 124
          ? `Command timed out after ${timeout}ms (exit code 124)`
          : `Command failed (exit code ${result.code})`;
      const managed = await boundToolOutput(meta + body, {
        maxChars: BASH_MAX_CHARS,
      });
      return { output: managed.text, isError: true };
    }
  const managed = await boundToolOutput(meta + (out || "(no output)"), {
      maxChars: BASH_MAX_CHARS,
    });
    return { output: managed.text };
  } catch (err) {
    if (ctx.signal?.aborted) {
      return { output: "Aborted", isError: true };
    }
    if (profile !== "off" && missingBackend === "fail-closed") {
      const managed = await boundToolOutput(
        `Sandbox error (fail-closed): ${(err as Error).message}`,
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text, isError: true };
    }
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: ctx.workspace,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        env,
        signal: ctx.signal,
      });
      const out = [stdout, stderr].filter(Boolean).join("\n");
      const managed = await boundToolOutput(
        `[sandbox:fallback] ${out || "(no output)"}`,
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text };
    } catch (err2) {
      if (ctx.signal?.aborted) {
        return { output: "Aborted", isError: true };
      }
      const e = err2 as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: number;
      };
      const out = [e.stdout, e.stderr, e.message, (err as Error).message]
        .filter(Boolean)
        .join("\n");
      const managed = await boundToolOutput(
        out || `Command failed (code ${e.code})`,
        { maxChars: BASH_MAX_CHARS },
      );
      return { output: managed.text, isError: true };
    }
  }
}
