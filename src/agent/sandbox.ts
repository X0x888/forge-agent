/**
 * OS-level sandbox for bash child processes.
 *
 * Profiles (inspired by Grok Build):
 *   off       — no confinement
 *   workspace — write: CWD + ~/.forge + temp; read: everywhere; network: yes
 *   read-only — write: ~/.forge + temp only; read: everywhere
 *   strict    — write: CWD + ~/.forge + temp; read: CWD + system libs (best-effort)
 *
 * macOS: sandbox-exec (Seatbelt)
 * Linux: bwrap (bubblewrap) when available; otherwise warn + soft mode
 * Windows: off (not supported)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { forgeHome } from "../util/fs.js";
import type { SandboxProfile } from "../config/types.js";

export interface SandboxRunOpts {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  profile: SandboxProfile;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  sandboxed: boolean;
  backend: string;
  warning?: string;
}

function which(bin: string): string | null {
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const p of paths) {
    const full = path.join(p, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* */
    }
  }
  return null;
}

function seatbeltProfile(opts: {
  profile: SandboxProfile;
  cwd: string;
  forge: string;
  tmp: string;
}): string {
  const cwd = opts.cwd;
  const forge = opts.forge;
  const tmp = opts.tmp;
  const privateTmp = "/private/tmp";
  const varTmp = "/var/tmp";
  const privateVarTmp = "/private/var/tmp";

  // writable subpaths
  const writePaths =
    opts.profile === "read-only"
      ? [forge, tmp, privateTmp, varTmp, privateVarTmp]
      : [cwd, forge, tmp, privateTmp, varTmp, privateVarTmp];

  const writeAllow = writePaths
    .map((p) => `  (subpath ${JSON.stringify(p)})`)
    .join("\n");

  // strict: deny reads outside cwd+system — seatbelt read deny is noisy;
  // we allow read * and rely on write restriction as the main control.
  // (Full strict read confinement needs more platform work.)
  return `
(version 1)
(debug deny)
(allow default)
(deny file-write*)
(deny file-write-mode)
(deny file-write-owner)
(deny file-write-setugid)
(allow file-write-data
${writeAllow}
  (literal "/dev/null")
  (literal "/dev/dtracehelper")
  (literal "/dev/tty")
  (regex #"^/dev/fd/")
  (regex #"^/dev/ttys")
)
(allow file-write*
${writeAllow}
  (literal "/dev/null")
  (regex #"^/dev/fd/")
  (regex #"^/dev/ttys")
)
(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys") (regex #"^/dev/fd/"))
(allow process-exec*)
(allow process-fork)
(allow process-info*)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
(allow mach-priv-host-port)
(allow network*)
`.trim();
}

function runRaw(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, opts.timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + "\n" + err.message, code: 1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Run a shell command, optionally sandboxed. */
export async function runSandboxed(opts: SandboxRunOpts): Promise<SandboxRunResult> {
  const profile = opts.profile || "off";
  const shell = process.env.SHELL || "/bin/bash";
  const shellArgs = ["-c", opts.command];

  if (profile === "off") {
    const r = await runRaw(shell, shellArgs, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
    });
    return {
      ...r,
      sandboxed: false,
      backend: "none",
    };
  }

  const platform = process.platform;
  const forge = forgeHome();
  const tmp = os.tmpdir();

  // --- macOS Seatbelt ---
  if (platform === "darwin") {
    const sb = which("sandbox-exec");
    if (sb) {
      const profileText = seatbeltProfile({
        profile,
        cwd: path.resolve(opts.cwd),
        forge: path.resolve(forge),
        tmp: path.resolve(tmp),
      });
      // write temp profile
      const profPath = path.join(
        tmp,
        `forge-sbx-${process.pid}-${Date.now()}.sb`,
      );
      try {
        fs.writeFileSync(profPath, profileText, { mode: 0o600 });
        const r = await runRaw(
          sb,
          ["-f", profPath, shell, ...shellArgs],
          {
            cwd: opts.cwd,
            timeoutMs: opts.timeoutMs,
            env: opts.env,
          },
        );
        return {
          ...r,
          sandboxed: true,
          backend: "sandbox-exec",
        };
      } finally {
        try {
          fs.unlinkSync(profPath);
        } catch {
          /* */
        }
      }
    }
    return {
      stdout: "",
      stderr: "",
      code: 1,
      sandboxed: false,
      backend: "none",
      warning:
        "sandbox-exec not found; running unsandboxed. Install Xcode CLT or set sandbox=off.",
    };
  }

  // --- Linux: bubblewrap ---
  if (platform === "linux") {
    const bwrap = which("bwrap");
    if (bwrap) {
      const cwd = path.resolve(opts.cwd);
      const args: string[] = [
        "--die-with-parent",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        // read-only root
        "--ro-bind",
        "/",
        "/",
        // writable binds
        "--bind",
        tmp,
        tmp,
      ];
      if (profile !== "read-only") {
        args.push("--bind", cwd, cwd);
      }
      // forge home always writable for session state if tools need it
      try {
        fs.mkdirSync(forge, { recursive: true });
      } catch {
        /* */
      }
      args.push("--bind", path.resolve(forge), path.resolve(forge));
      // tmp vars
      args.push("--chdir", cwd);
      if (profile === "strict" || profile === "read-only") {
        // still allow network for package managers in workspace; strict
        // network block would break npm — keep network for now
      }
      args.push("--", shell, ...shellArgs);
      const r = await runRaw(bwrap, args, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
      });
      return { ...r, sandboxed: true, backend: "bwrap" };
    }
    return {
      stdout: "",
      stderr: "",
      code: 1,
      sandboxed: false,
      backend: "none",
      warning:
        "bwrap (bubblewrap) not found; running unsandboxed. Install bubblewrap or set sandbox=off. Hard deny rules still apply.",
    };
  }

  return {
    stdout: "",
    stderr: "",
    code: 1,
    sandboxed: false,
    backend: "none",
    warning: `Sandbox not supported on ${platform}; running unsandboxed.`,
  };
}

/**
 * Execute command with sandbox when profile != off.
 * On sandbox backend missing, falls back to unsandboxed with warning in stderr.
 */
export async function execCommandSandboxed(opts: SandboxRunOpts): Promise<SandboxRunResult> {
  if (opts.profile === "off") {
    const r = await runRaw(process.env.SHELL || "/bin/bash", ["-c", opts.command], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
    });
    return { ...r, sandboxed: false, backend: "none" };
  }

  const result = await runSandboxed(opts);
  if (!result.sandboxed && result.warning) {
    // fallback unsandboxed so agent can still work, but flag clearly
    const r = await runRaw(process.env.SHELL || "/bin/bash", ["-c", opts.command], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
    });
    return {
      ...r,
      sandboxed: false,
      backend: "none",
      warning: result.warning,
      stderr:
        (result.warning ? `[forge sandbox] ${result.warning}\n` : "") + (r.stderr || ""),
    };
  }
  return result;
}

export function describeSandbox(profile: SandboxProfile): string {
  switch (profile) {
    case "off":
      return "off (no OS confinement)";
    case "workspace":
      return "workspace (write: CWD + ~/.forge + temp)";
    case "read-only":
      return "read-only (write: ~/.forge + temp only)";
    case "strict":
      return "strict (write: CWD + ~/.forge + temp; tighter where supported)";
    default:
      return String(profile);
  }
}
