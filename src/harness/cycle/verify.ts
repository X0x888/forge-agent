/**
 * Harness-run verification — the cycle gate no model's claim can stamp.
 *
 * After the Reviewer returns, the harness runs the declared verify command
 * itself, observes the exit code and the output tail, and classifies the
 * run with the same rules the loop applies to the model's bash calls. Green
 * commits; red sends the executor back with the tail.
 */
import { spawn } from "node:child_process";
import { createChildEnv } from "../../agent/tools/env-policy.js";
import { envPositiveInt } from "../../util/env.js";
import { classifyVerificationRun, type VerificationRunClass } from "../verification.js";

export interface CheckRun {
  command: string;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  ms: number;
  cls: VerificationRunClass;
}

const OUTPUT_TAIL = 16_000;

export function verifyTimeoutMs(): number {
  return envPositiveInt("FORGE_ULW_VERIFY_TIMEOUT_MS", 20 * 60 * 1000);
}

export async function runCheckCommand(opts: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  preferredCheckCommands?: string[];
}): Promise<CheckRun> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? verifyTimeoutMs();
  return new Promise<CheckRun>((resolve) => {
    let out = "";
    let timedOut = false;
    let settled = false;
    const child = spawn("/bin/sh", ["-c", opts.command], {
      cwd: opts.cwd,
      env: { ...createChildEnv(), CI: process.env.CI ?? "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const push = (chunk: Buffer | string) => {
      out += String(chunk);
      if (out.length > OUTPUT_TAIL * 2) out = out.slice(-OUTPUT_TAIL);
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const output = out.length > OUTPUT_TAIL ? out.slice(-OUTPUT_TAIL) : out;
      let cls = classifyVerificationRun({
        command: opts.command,
        exitCode: timedOut ? 1 : exitCode,
        isError: timedOut || exitCode !== 0,
        output,
        preferredCheckCommands: opts.preferredCheckCommands,
      });
      if (!cls.ran) {
        // The harness ran a declared check; treat the result as a check run
        // even when the shape is unknown to the stack table.
        const passed = !timedOut && exitCode === 0;
        cls = { ran: true, passed, isolate: false, fullSuite: passed };
      }
      if (timedOut) cls = { ...cls, passed: false, fullSuite: false };
      resolve({
        command: opts.command,
        exitCode: timedOut ? null : exitCode,
        output,
        timedOut,
        ms: Date.now() - started,
        cls,
      });
    };
    const kill = () => {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* gone */
          }
        }, 5_000).unref();
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      out += `\n[forge] verify timed out after ${Math.round(timeoutMs / 1000)}s`;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      out += `\n[forge] verify aborted`;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      out += `\n[forge] spawn error: ${(err as Error).message}`;
      finish(1);
    });
    child.on("close", (code) => finish(code));
  });
}
