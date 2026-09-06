/**
 * Harness-run verification — the cycle gate no model's claim can stamp.
 *
 * The harness runs the declared verify command itself, observes the exit
 * code and the output, and classifies the run with the same rules the loop
 * applies to the model's bash calls. Green commits; red sends the executor
 * back with the tail.
 *
 * A gate is judged against a **baseline**: the failures the suite had before
 * the cycle touched anything. A repo with pre-existing environment failures
 * (no TTY, no build artefact, a flaky integration test) is otherwise never
 * green, and the first dogfood spent three fix rounds editing tests it had
 * not broken. The rule is the one `AGENTS.md` gives a human: diff the ✖
 * lines against the baseline. New failures are red; old ones are reported.
 */
import { spawn } from "node:child_process";
import { createChildEnv } from "../../agent/tools/env-policy.js";
import { envPositiveInt } from "../../util/env.js";
import {
  classifyVerificationRun,
  extractFailingTests,
  type VerificationRunClass,
} from "../verification.js";

export interface CheckRun {
  command: string;
  exitCode: number | null;
  /** Full output (capped) — what the baseline diff reads. */
  output: string;
  /** Last lines — what the executor's re-anchor and the log show. */
  tail: string;
  timedOut: boolean;
  ms: number;
  cls: VerificationRunClass;
  /** Failing test names the runner reported (empty for an unknown runner). */
  failures: string[];
}

export interface VerifyBaseline {
  command: string;
  exitCode: number | null;
  failures: string[];
  at: string;
}

export interface GateVerdict {
  passed: boolean;
  /** Failures not in the baseline — the executor's to fix. */
  newFailures: string[];
  /** Baseline failures still present — reported, not the executor's job. */
  inherited: string[];
  /** Why the verdict fell where it did; one line for the log and the record. */
  note: string;
}

const OUTPUT_CAP = 2 * 1024 * 1024;
const TAIL = 16_000;

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
    const chunks: string[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    const child = spawn("/bin/sh", ["-c", opts.command], {
      cwd: opts.cwd,
      env: { ...createChildEnv(), CI: process.env.CI ?? "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const push = (chunk: Buffer | string) => {
      const s = String(chunk);
      if (size + s.length > OUTPUT_CAP) return;
      chunks.push(s);
      size += s.length;
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const output = chunks.join("");
      const tail = output.length > TAIL ? output.slice(-TAIL) : output;
      let cls = classifyVerificationRun({
        command: opts.command,
        exitCode: timedOut ? 1 : exitCode,
        isError: timedOut || exitCode !== 0,
        output: tail,
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
        tail,
        timedOut,
        ms: Date.now() - started,
        cls,
        failures: timedOut ? [] : extractFailingTests(output),
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
      push(`\n[forge] verify timed out after ${Math.round(timeoutMs / 1000)}s`);
      kill();
    }, timeoutMs);
    const onAbort = () => {
      push(`\n[forge] verify aborted`);
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      push(`\n[forge] spawn error: ${(err as Error).message}`);
      finish(1);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Green means: the run passed outright, or every failure it has was already
 * failing before the cycle (same command). A red run whose failures cannot
 * be named — a timeout, a crash, an unknown runner — is red whatever the
 * baseline says: there is nothing to compare.
 */
export function judgeAgainstBaseline(
  run: Pick<CheckRun, "command" | "exitCode" | "timedOut" | "failures" | "cls">,
  baseline: VerifyBaseline | undefined,
): GateVerdict {
  if (run.cls.passed) {
    return { passed: true, newFailures: [], inherited: [], note: "green" };
  }
  if (run.timedOut) {
    return { passed: false, newFailures: [], inherited: [], note: "timed out" };
  }
  if (!baseline || baseline.command !== run.command) {
    return {
      passed: false,
      newFailures: run.failures,
      inherited: [],
      note: run.failures.length
        ? `red — ${run.failures.length} failing, no baseline for \`${run.command}\``
        : `red — exit ${run.exitCode ?? "?"}, no failing tests named`,
    };
  }
  if (!run.failures.length) {
    return {
      passed: false,
      newFailures: [],
      inherited: [],
      note: `red — exit ${run.exitCode ?? "?"} with no failing tests named; nothing to diff against the baseline`,
    };
  }
  const base = new Set(baseline.failures);
  const newFailures = run.failures.filter((f) => !base.has(f));
  const inherited = run.failures.filter((f) => base.has(f));
  if (newFailures.length) {
    return {
      passed: false,
      newFailures,
      inherited,
      note: `red — ${newFailures.length} new failure(s)${inherited.length ? `, ${inherited.length} pre-existing` : ""}`,
    };
  }
  return {
    passed: true,
    newFailures: [],
    inherited,
    note: `green vs baseline — ${inherited.length} pre-existing failure(s) unchanged`,
  };
}
