/**
 * Background shell tasks (Grok/OpenCode simplified).
 * In-process registry: start → get_task_output → kill_task.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pushInterjection } from "../../harness/interjection.js";
import { loadUlwCycle } from "../../harness/ulw-cycle.js";
import { maybeDesktopNotify } from "../../util/attention.js";
import { forgeHome, ensureDirAsync, nowIso } from "../../util/fs.js";
import { createShellEnv } from "./env-policy.js";
import {
  applyBashTreeDelta,
  type BashTreeSnapshot,
} from "./bash-mutation-journal.js";
import type { ToolContext } from "./types.js";
import {
  appendFileMutation,
  mutationAbsPathsAfter,
  onBeforeRestoreMutations,
} from "../../session/mutations.js";
import type {
  SandboxMissingBackend,
  SandboxNetwork,
  SandboxProfile,
} from "../../config/types.js";
import { defaultNetworkForProfile } from "../../config/types.js";
import {
  detectSandboxBackend,
  seatbeltProfile,
  ensureForgeSandboxWriteRoots,
  bwrapForgeWriteBinds,
  bwrapProtectedRoBinds,
} from "../sandbox.js";
import { syncBackgroundCounts } from "../../statusline/activity.js";
import {
  killProcessTree,
  registerInflightChild,
  spawnOwnGroupOpts,
} from "../../util/process-tree.js";

export type TaskStatus = "running" | "completed" | "failed" | "killed" | "timeout";

export interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  status: TaskStatus;
  pid?: number;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  stdoutPath: string;
  stderrPath: string;
  error?: string;
  sandboxed: boolean;
  backend: string;
  child?: ChildProcess;
}

const tasks = new Map<string, BackgroundTask>();
/** Side map so list/JSON snapshots stay lean. */
const journals = new Map<string, BackgroundTaskJournal>();
const MAX_TASKS = 32;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export type BackgroundTaskJournal = {
  snap: BashTreeSnapshot;
  ctx: ToolContext;
  startedAt: string;
  startedTurn?: number;
  settled?: boolean;
};

function attachJournal(
  id: string,
  journal: {
    snap: BashTreeSnapshot;
    ctx: ToolContext;
    startedTurn?: number;
  },
): void {
  journals.set(id, {
    snap: journal.snap,
    ctx: journal.ctx,
    startedAt: nowIso(),
    startedTurn: journal.startedTurn,
    settled: false,
  });
}

/** Apply porcelain delta once. Concurrent write_file paths are skipped. */
export function settleTaskJournal(
  task: BackgroundTask,
  opts?: { undoThrough?: number },
): number {
  const j = journals.get(task.id);
  if (!j || j.settled) return 0;
  j.settled = true;
  try {
    const ignore =
      j.ctx.sessionId
        ? mutationAbsPathsAfter(j.ctx.sessionId, j.startedAt)
        : undefined;
    let ctx = j.ctx;
    // /undo already decremented turnCount. Stamp keepThrough+1 so restore
    // sees the entries in the doomed set (live turnCount would keep them).
    if (
      typeof opts?.undoThrough === "number" &&
      ctx.sessionId &&
      ctx.recordMutation
    ) {
      const sid = ctx.sessionId;
      const turn = opts.undoThrough + 1;
      ctx = {
        ...ctx,
        recordMutation: (input) => {
          appendFileMutation(sid, { ...input, turn });
        },
      };
    }
    return applyBashTreeDelta(
      j.snap,
      ctx,
      ignore && ignore.size ? { ignoreAbsPaths: ignore } : undefined,
    );
  } catch {
    return 0;
  }
}

/**
 * Journal + SIGKILL in-flight bg writers for this session.
 * When `keepThroughTurn` is set ( /undo ), only tasks started after that
 * turn are settled — an earlier turn's codegen stays running.
 */
export function settleBackgroundMutationJournals(
  sessionId: string,
  keepThroughTurn?: number,
): number {
  if (!sessionId) return 0;
  let n = 0;
  for (const task of tasks.values()) {
    const j = journals.get(task.id);
    if (!j || j.settled) continue;
    if (j.ctx.sessionId !== sessionId) continue;
    if (typeof keepThroughTurn === "number") {
      if (typeof j.startedTurn !== "number") continue;
      if (j.startedTurn <= keepThroughTurn) continue;
    }
    if (task.status === "running") {
      try {
        if (task.child) killProcessTree(task.child, "SIGKILL");
      } catch {
        /* */
      }
      task.status = "killed";
      task.endedAt = Date.now();
    }
    n += settleTaskJournal(
      task,
      typeof keepThroughTurn === "number"
        ? { undoThrough: keepThroughTurn }
        : undefined,
    );
  }
  if (n > 0) publishBgActivity();
  return n;
}

onBeforeRestoreMutations((sessionId, keepThroughTurn) => {
  settleBackgroundMutationJournals(sessionId, keepThroughTurn);
});

function tasksDir(): string {
  return path.join(forgeHome(), "background-tasks");
}

function newId(): string {
  return `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pruneOld(): void {
  if (tasks.size < MAX_TASKS) return;
  const done = [...tasks.values()]
    .filter((t) => t.status !== "running")
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  while (tasks.size >= MAX_TASKS && done.length) {
    const t = done.shift()!;
    tasks.delete(t.id);
    journals.delete(t.id);
  }
}

function publishBgActivity(): void {
  const all = [...tasks.values()];
  const running = all.filter((t) => t.status === "running");
  const hint = running[0]
    ? running[0].command.replace(/\s+/g, " ").slice(0, 48)
    : undefined;
  syncBackgroundCounts({
    running: running.length,
    total: all.length,
    hint,
  });
}

interface SpawnPlan {
  file: string;
  args: string[];
  sandboxed: boolean;
  backend: string;
  cleanup?: () => void;
}

function planSpawn(opts: {
  command: string;
  cwd: string;
  profile: SandboxProfile;
  network?: SandboxNetwork;
  missingBackend: SandboxMissingBackend;
}): SpawnPlan | { failClosed: true; message: string } {
  const shell = process.env.SHELL || "/bin/bash";
  const profile = opts.profile || "workspace";
  const network = opts.network ?? defaultNetworkForProfile(profile);
  const restrictNetwork = network === "blocked";

  if (profile === "off") {
    return {
      file: shell,
      args: ["-c", opts.command],
      sandboxed: false,
      backend: "none",
    };
  }

  const detected = detectSandboxBackend();
  const forge = forgeHome();
  const tmp = os.tmpdir();
  const cwd = path.resolve(opts.cwd);

  if (process.platform === "darwin" && detected.path) {
    ensureForgeSandboxWriteRoots(forge);
    const profPath = path.join(
      tmp,
      `forge-bg-sbx-${process.pid}-${Date.now()}.sb`,
    );
    fs.writeFileSync(
      profPath,
      seatbeltProfile({
        profile,
        cwd,
        forge: path.resolve(forge),
        tmp: path.resolve(tmp),
        restrictNetwork,
      }),
      { mode: 0o600 },
    );
    return {
      file: detected.path,
      args: ["-f", profPath, shell, "-c", opts.command],
      sandboxed: true,
      backend: "sandbox-exec",
      cleanup: () => {
        try {
          fs.unlinkSync(profPath);
        } catch {
          /* */
        }
      },
    };
  }

  if (process.platform === "linux" && detected.path) {
    const args: string[] = [
      "--die-with-parent",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      tmp,
      tmp,
    ];
    if (profile !== "read-only") {
      args.push("--bind", cwd, cwd);
      args.push(...bwrapProtectedRoBinds(cwd));
    }
    args.push(...bwrapForgeWriteBinds(forge));
    if (restrictNetwork) args.push("--unshare-net");
    args.push("--chdir", cwd, "--", shell, "-c", opts.command);
    return {
      file: detected.path,
      args,
      sandboxed: true,
      backend: "bwrap",
    };
  }

  if (opts.missingBackend === "fail-closed") {
    return {
      failClosed: true,
      message:
        detected.available
          ? `Sandbox not supported for background on ${process.platform}`
          : `Sandbox backend unavailable (fail-closed). Install bwrap / Xcode CLT, or set sandbox=off.`,
    };
  }

  return {
    file: shell,
    args: ["-c", opts.command],
    sandboxed: false,
    backend: "none",
  };
}

function ulwLastInFlight(sessionId: string): boolean {
  try {
    const ulw = loadUlwCycle(sessionId);
    return Boolean(ulw?.enabled && ulw.cycle === 0);
  } catch {
    return false;
  }
}

/** Last lines of bg stdout/stderr included in the completion interjection. */
export const BG_COMPLETION_TAIL_LINES = 8;
const BG_TAIL_READ_BYTES = 64 * 1024;

/** Last nonempty lines of captured log text (stderr preferred by callers). */
export function peekLogTextTail(
  text: string,
  maxLines = BG_COMPLETION_TAIL_LINES,
): string {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/u, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const nonempty = lines.filter((l) => l.trim());
  return nonempty.slice(-maxLines).join("\n");
}

export function formatBackgroundCompletionInterjection(opts: {
  id: string;
  status: string;
  exitCode: number | null;
  durationMs: number;
  command: string;
  tail?: string;
}): string {
  const code =
    opts.exitCode === null || opts.exitCode === undefined
      ? "?"
      : String(opts.exitCode);
  const raw = String(opts.command || "");
  const cmd = raw.slice(0, 120);
  const tail = (opts.tail ?? "").trim();
  return (
    `[Forge harness — background task ${opts.status}]\n` +
    `task_id=${opts.id}  exit=${code}  ${opts.durationMs}ms\n` +
    `command: ${cmd}${raw.length > 120 ? "…" : ""}\n` +
    (tail ? `--- last output ---\n${tail}\n` : "") +
    `Use get_task_output({ task_id: "${opts.id}" }) only if you need more than this tail. ` +
    `Do not ask the user — act on the result.`
  );
}

export function peekTaskLastLine(
  task: Pick<BackgroundTask, "stdoutPath" | "stderrPath">,
): string {
  const tail = readTaskLogTailSync(task);
  const lines = tail.split("\n").filter((l) => l.trim());
  return lines[lines.length - 1] ?? "";
}

function readTaskLogTailSync(
  task: Pick<BackgroundTask, "stdoutPath" | "stderrPath">,
): string {
  const readEnd = (file: string): string => {
    try {
      const st = fs.statSync(file);
      if (st.size <= 0) return "";
      const start = Math.max(0, st.size - BG_TAIL_READ_BYTES);
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        return buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "";
    }
  };
  const err = peekLogTextTail(readEnd(task.stderrPath));
  const out = peekLogTextTail(readEnd(task.stdoutPath));
  if (err && out) return peekLogTextTail(`${err}\n${out}`);
  return err || out;
}

function maybeNotifyBgComplete(
  task: BackgroundTask,
  sessionId?: string,
): void {
  const off = (process.env.FORGE_BG_NOTIFY || "1").trim().toLowerCase();
  if (off === "0" || off === "false" || off === "off" || off === "no") return;
  if (!sessionId) return;
  try {
    const dur =
      task.endedAt && task.startedAt
        ? Math.max(0, task.endedAt - task.startedAt)
        : 0;
    const cmd = String(task.command || "").slice(0, 120);
    const status = task.status;
    const code =
      task.exitCode === null || task.exitCode === undefined
        ? "?"
        : String(task.exitCode);
    const msg = formatBackgroundCompletionInterjection({
      id: task.id,
      status,
      exitCode: task.exitCode,
      durationMs: dur,
      command: String(task.command || ""),
      tail: readTaskLogTailSync(task),
    });
    // LAST / Cycle-complete in flight: desktop notify only — do not open
    // another user-channel turn while the model is already winding down.
    if (!ulwLastInFlight(sessionId)) {
      pushInterjection(sessionId, msg);
    }
    maybeDesktopNotify({
      title: `Forge · bg ${status}`,
      body: `exit=${code}  ${dur}ms  ${cmd}`,
      subtitle: task.id,
    });
  } catch {
    /* never break bg lifecycle */
  }
}

export async function startBackgroundTask(opts: {
  command: string;
  cwd: string;
  profile: SandboxProfile;
  network?: SandboxNetwork;
  missingBackend?: SandboxMissingBackend;
  timeoutMs?: number;
  /** When set, completion pushes a mid-run interjection so the agent continues without polling. */
  sessionId?: string;
  /** Snapshot taken before spawn; applied on exit / /undo settle. */
  journal?: {
    snap: BashTreeSnapshot;
    ctx: ToolContext;
    startedTurn?: number;
  };
}): Promise<
  | { ok: true; task: BackgroundTask }
  | { ok: false; message: string; failClosed?: boolean }
> {
  pruneOld();
  const plan = planSpawn({
    command: opts.command,
    cwd: opts.cwd,
    profile: opts.profile,
    network: opts.network,
    missingBackend: opts.missingBackend ?? "fail-closed",
  });
  if ("failClosed" in plan && plan.failClosed) {
    return { ok: false, message: plan.message, failClosed: true };
  }
  const spawnPlan = plan as SpawnPlan;

  const id = newId();
  const dir = path.join(tasksDir(), id);
  await ensureDirAsync(dir);
  const stdoutPath = path.join(dir, "stdout.txt");
  const stderrPath = path.join(dir, "stderr.txt");
  await fsp.writeFile(stdoutPath, "", "utf8");
  await fsp.writeFile(stderrPath, "", "utf8");

  const env = createShellEnv(process.env);
  const outFd = fs.openSync(stdoutPath, "a");
  const errFd = fs.openSync(stderrPath, "a");

  let child: ChildProcess;
  try {
    child = spawn(spawnPlan.file, spawnPlan.args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", outFd, errFd],
      ...spawnOwnGroupOpts(),
    });
    registerInflightChild(child);
  } catch (err) {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    spawnPlan.cleanup?.();
    return { ok: false, message: `Failed to spawn: ${(err as Error).message}` };
  }

  // Parent can close its copies; child keeps FDs
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  const task: BackgroundTask = {
    id,
    command: opts.command,
    cwd: opts.cwd,
    status: "running",
    pid: child.pid,
    exitCode: null,
    startedAt: Date.now(),
    stdoutPath,
    stderrPath,
    sandboxed: spawnPlan.sandboxed,
    backend: spawnPlan.backend,
    child,
  };
  tasks.set(id, task);
  if (opts.journal) attachJournal(id, opts.journal);
  publishBgActivity();

  const timeoutMs = opts.timeoutMs ?? 30 * 60_000; // 30m default for background
  const timer = setTimeout(() => {
    if (task.status === "running") {
      try {
        killProcessTree(child, "SIGTERM");
        // unref: SIGKILL grace must not hold the event loop after timeout.
        setTimeout(() => {
          killProcessTree(child, "SIGKILL");
        }, 3000).unref?.();
      } catch {
        /* */
      }
      task.status = "timeout";
      task.endedAt = Date.now();
      task.error = `Timed out after ${timeoutMs}ms`;
      publishBgActivity();
    }
  }, timeoutMs);
  timer.unref?.();

  child.on("exit", (code) => {
    clearTimeout(timer);
    spawnPlan.cleanup?.();
    if (task.status === "running") {
      task.status = code === 0 ? "completed" : "failed";
      task.exitCode = code;
      task.endedAt = Date.now();
    } else if (task.status === "timeout" || task.status === "killed") {
      task.exitCode = code;
      task.endedAt = task.endedAt || Date.now();
    }
    task.child = undefined;
    settleTaskJournal(task);
    publishBgActivity();
    maybeNotifyBgComplete(task, opts.sessionId);
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    spawnPlan.cleanup?.();
    task.status = "failed";
    task.error = err.message;
    task.endedAt = Date.now();
    task.child = undefined;
    settleTaskJournal(task);
    publishBgActivity();
    maybeNotifyBgComplete(task, opts.sessionId);
  });

  return { ok: true, task };
}

export function getTask(id: string): BackgroundTask | undefined {
  return tasks.get(id);
}

export function listTasks(): BackgroundTask[] {
  return [...tasks.values()];
}

/**
 * Block until a background task leaves `running`, or until timeoutMs elapses.
 * Uses the child process `close` event when available; falls back to polling.
 * Returns the task snapshot (may still be running on timeout).
 */
export async function waitForTask(
  id: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<
  | { ok: true; task: BackgroundTask; timedOut: boolean; waitedMs: number }
  | { ok: false; error: string }
> {
  const task = tasks.get(id);
  if (!task) return { ok: false, error: `Unknown task_id: ${id}` };

  const timeoutMs = Math.max(
    0,
    Math.min(
      30 * 60_000,
      Number.isFinite(opts.timeoutMs as number)
        ? Math.floor(opts.timeoutMs as number)
        : 120_000,
    ),
  );
  const pollMs = Math.max(25, Math.min(2000, opts.pollMs ?? 100));
  const started = Date.now();

  if (task.status !== "running") {
    return { ok: true, task, timedOut: false, waitedMs: 0 };
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        task.child?.off?.("close", onClose);
      } catch {
        /* */
      }
      clearInterval(poller);
      clearTimeout(timer);
      resolve();
    };
    const onClose = () => finish();
    try {
      task.child?.once?.("close", onClose);
    } catch {
      /* */
    }
    const poller = setInterval(() => {
      const t = tasks.get(id);
      if (!t || t.status !== "running") finish();
    }, pollMs);
    poller.unref?.();
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });

  const final = tasks.get(id) || task;
  const waitedMs = Date.now() - started;
  const timedOut = final.status === "running";
  return { ok: true, task: final, timedOut, waitedMs };
}

export type WaitTasksMode = "any" | "all";

export type WaitForTasksResult =
  | {
      ok: true;
      tasks: BackgroundTask[];
      winner?: BackgroundTask;
      stillRunning: BackgroundTask[];
      timedOut: boolean;
      waitedMs: number;
      mode: WaitTasksMode;
    }
  | { ok: false; error: string };

/**
 * Block until background tasks leave `running` (grok-build wait_any / wait_all).
 * Empty `ids` locks the running set at start.
 */
export async function waitForTasks(
  ids: string[],
  opts: { timeoutMs?: number; pollMs?: number; mode?: WaitTasksMode } = {},
): Promise<WaitForTasksResult> {
  const mode: WaitTasksMode = opts.mode === "any" ? "any" : "all";
  const timeoutMs = Math.max(
    0,
    Math.min(
      30 * 60_000,
      Number.isFinite(opts.timeoutMs as number)
        ? Math.floor(opts.timeoutMs as number)
        : 120_000,
    ),
  );
  const pollMs = Math.max(25, Math.min(2000, opts.pollMs ?? 100));
  const started = Date.now();

  const raw = [...new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean))];
  const lockedIds =
    raw.length > 0
      ? raw
      : [...tasks.values()].filter((t) => t.status === "running").map((t) => t.id);
  if (lockedIds.length === 0) {
    return {
      ok: false,
      error:
        "No running background tasks to wait on. Start one with bash { background: true }.",
    };
  }
  const missing = lockedIds.find((id) => !tasks.has(id));
  if (missing) return { ok: false, error: `Unknown task_id: ${missing}` };

  const snapshot = (): {
    tasks: BackgroundTask[];
    done: BackgroundTask[];
    still: BackgroundTask[];
  } => {
    const listed = lockedIds
      .map((id) => tasks.get(id))
      .filter((t): t is BackgroundTask => Boolean(t));
    return {
      tasks: listed,
      done: listed.filter((t) => t.status !== "running"),
      still: listed.filter((t) => t.status === "running"),
    };
  };

  const first = snapshot();
  const already = mode === "any" ? first.done.length > 0 : first.still.length === 0;
  if (already || timeoutMs === 0) {
    return {
      ok: true,
      tasks: first.tasks,
      winner: first.done[0],
      stillRunning: first.still,
      timedOut: mode === "any" ? first.done.length === 0 : first.still.length > 0,
      waitedMs: 0,
      mode,
    };
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const watched = first.still
      .map((t) => t.child)
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const child of watched) {
        try {
          child.off?.("close", onClose);
        } catch {
          /* */
        }
      }
      clearInterval(poller);
      clearTimeout(timer);
      resolve();
    };
    const onClose = () => {
      const snap = snapshot();
      const hit = mode === "any" ? snap.done.length > 0 : snap.still.length === 0;
      if (hit) finish();
    };
    for (const child of watched) {
      try {
        child.once?.("close", onClose);
      } catch {
        /* */
      }
    }
    const poller = setInterval(() => {
      const snap = snapshot();
      const hit = mode === "any" ? snap.done.length > 0 : snap.still.length === 0;
      if (hit) finish();
    }, pollMs);
    poller.unref?.();
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });

  const final = snapshot();
  const waitedMs = Date.now() - started;
  const timedOut = mode === "any" ? final.done.length === 0 : final.still.length > 0;
  return {
    ok: true,
    tasks: final.tasks,
    winner: final.done[0],
    stillRunning: final.still,
    timedOut,
    waitedMs,
    mode,
  };
}

export async function readTaskOutput(
  id: string,
  opts: { tail?: number; stream?: "stdout" | "stderr" | "both" } = {},
): Promise<string> {
  const task = tasks.get(id);
  if (!task) return `Unknown task_id: ${id}`;

  const stream = opts.stream || "both";
  // tail: undefined → 200; 0 → full captured output; positive → last N lines
  const tailRaw = opts.tail;
  const tail =
    typeof tailRaw === "number" && Number.isFinite(tailRaw) && tailRaw >= 0
      ? Math.floor(tailRaw)
      : 200;
  const parts: string[] = [
    `task_id: ${task.id}`,
    `status: ${task.status}`,
    `pid: ${task.pid ?? "n/a"}`,
    `exit_code: ${task.exitCode === null ? "n/a" : task.exitCode}`,
    `sandbox: ${task.backend}${task.sandboxed ? "" : " (unsandboxed)"}`,
    `command: ${task.command}`,
    `elapsed_ms: ${(task.endedAt || Date.now()) - task.startedAt}`,
  ];
  if (task.error) parts.push(`error: ${task.error}`);
  if (task.status !== "running") {
    parts.push(
      `note: task is ${task.status} — output below is final; start a new background bash if you need another run.`,
    );
  }

  const readTail = async (file: string, label: string) => {
    try {
      const st = await fsp.stat(file);
      let text: string;
      if (st.size > MAX_CAPTURE_BYTES) {
        const fh = await fsp.open(file, "r");
        try {
          const start = Math.max(0, st.size - MAX_CAPTURE_BYTES);
          const buf = Buffer.alloc(st.size - start);
          await fh.read(buf, 0, buf.length, start);
          text = buf.toString("utf8");
        } finally {
          await fh.close();
        }
        text = `[… earlier output truncated, file ${file} ${st.size} bytes …]\n` + text;
      } else {
        text = await fsp.readFile(file, "utf8");
      }
      const lines = text.split("\n");
      const slice =
        tail === 0 || lines.length <= tail ? lines : lines.slice(-tail);
      const head =
        tail === 0
          ? `\n--- ${label} (${lines.length} lines) ---`
          : `\n--- ${label} (last ${slice.length}/${lines.length} lines) ---`;
      parts.push(head, slice.join("\n") || "(empty)");
    } catch (err) {
      parts.push(`\n--- ${label} ---\n(error reading: ${(err as Error).message})`);
    }
  };

  if (stream === "stdout" || stream === "both") await readTail(task.stdoutPath, "stdout");
  if (stream === "stderr" || stream === "both") await readTail(task.stderrPath, "stderr");
  parts.push(
    `\nFull logs: ${task.stdoutPath}` +
      (stream !== "stdout" ? ` and ${task.stderrPath}` : ""),
  );
  return parts.join("\n");
}

export function killTask(id: string): string {
  const task = tasks.get(id);
  if (!task) return `Unknown task_id: ${id}`;
  if (task.status !== "running") {
    const cmd = task.command.replace(/\s+/g, " ").slice(0, 80);
    const cmdNote = cmd ? ` · ${cmd}${task.command.length > 80 ? "…" : ""}` : "";
    return (
      `Task ${id} is already ${task.status} (exit ${task.exitCode ?? "n/a"})${cmdNote}\n` +
      `Use get_task_output to read logs, or start a new bash { background: true } task.`
    );
  }
  try {
    if (task.child) killProcessTree(task.child, "SIGTERM");
    // unref: SIGKILL grace must not hold the event loop (delays CLI exit).
    const child = task.child;
    setTimeout(() => {
      if (child) killProcessTree(child, "SIGKILL");
    }, 2000).unref?.();
  } catch (err) {
    return `Failed to kill ${id}: ${(err as Error).message}`;
  }
  task.status = "killed";
  task.endedAt = Date.now();
  publishBgActivity();
  return `Killed task ${id} (pid ${task.pid ?? "n/a"})`;
}

/**
 * Terminate all in-process background shell tasks (REPL exit / process teardown).
 * SIGTERM first; optional immediate SIGKILL for hard exit paths.
 * Returns how many running tasks were signalled.
 */
export function killAllRunningTasks(opts?: {
  /** When true, send SIGKILL immediately (no 2s grace). Default false. */
  force?: boolean;
}): number {
  let n = 0;
  for (const task of tasks.values()) {
    if (task.status !== "running") continue;
    n += 1;
    try {
      const child = task.child;
      if (opts?.force) {
        if (child) killProcessTree(child, "SIGKILL");
      } else {
        if (child) killProcessTree(child, "SIGTERM");
        // unref: teardown-path SIGKILL grace must not delay process exit.
        setTimeout(() => {
          if (
            child &&
            (task.status === "running" || task.status === "killed")
          ) {
            killProcessTree(child, "SIGKILL");
          }
        }, 1500).unref?.();
      }
    } catch {
      /* */
    }
    task.status = "killed";
    task.endedAt = Date.now();
    settleTaskJournal(task);
  }
  if (n > 0) publishBgActivity();
  return n;
}

/** Test helper */
export function _resetTasksForTests(): void {
  for (const t of tasks.values()) {
    try {
      if (t.child) killProcessTree(t.child, "SIGKILL");
    } catch {
      /* */
    }
  }
  tasks.clear();
  journals.clear();
  publishBgActivity();
}

let exitHookInstalled = false;

/**
 * Best-effort safety net: if the process dies without going through REPL/headless
 * teardown, still try to kill in-process background shells.
 * Idempotent; safe to call multiple times.
 */
export function installBackgroundTaskExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const run = () => {
    try {
      killAllRunningTasks({ force: true });
    } catch {
      /* */
    }
  };
  process.once("exit", run);
  process.once("beforeExit", run);
}
