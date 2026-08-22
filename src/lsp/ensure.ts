/**
 * Smooth LSP ensure: detect project languages, install missing servers.
 *
 * Policy (product bottom-line):
 * - Always ensure TypeScript + Python (default pack)
 * - Also ensure Rust/Go when project markers present
 * - Swift: tip only (platform-heavy)
 * - Shell: tip shellcheck, no LSP auto-install
 *
 * Env:
 *   FORGE_LSP_AUTO=0     — skip auto ensure on init/REPL (CLI `forge lsp ensure` still works)
 *   FORGE_LSP_AUTO_INSTALL=0 — detect/report only, never run installers
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createChildEnv } from "../agent/tools/env-policy.js";
import { forgeHome, ensureDir, readJsonFile, writeJsonFile } from "../util/fs.js";
import { log } from "../util/log.js";
import {
  detectProjectLanguages,
  languagesToEnsure,
  type DetectedLanguageId,
  type ProjectLanguageSignals,
} from "./detect.js";
import {
  formatLspInstallGuide,
  recipeForLanguage,
  type LspInstallRecipe,
} from "./install-guide.js";
import { commandOnPath } from "./path-util.js";

export interface EnsurePlanItem {
  languageId: DetectedLanguageId | string;
  label: string;
  command: string;
  onPath: boolean;
  tier: "default" | "project" | "optional";
  reasons: string[];
  /** Runnable install argv (best primary). */
  installArgv?: string[];
  /** Human one-liner */
  installHint: string;
  /** Cannot auto-install safely (swift, manual). */
  manualOnly?: boolean;
  tip?: string;
}

export interface EnsurePlan {
  workspace: string;
  detected: ProjectLanguageSignals[];
  items: EnsurePlanItem[];
  /** Missing and auto-installable */
  toInstall: EnsurePlanItem[];
  /** Missing but manual / tip-only */
  tips: EnsurePlanItem[];
  /** Already on PATH among recommended */
  ready: EnsurePlanItem[];
}

export interface EnsureResult {
  plan: EnsurePlan;
  installed: string[];
  failed: Array<{ languageId: string; error: string }>;
  skipped: string[];
  dryRun: boolean;
}

/** Structured install commands for each language (argv form). */
const INSTALL_ARGV: Record<
  string,
  { argv: string[]; hint: string; manualOnly?: boolean; tip?: string }
> = {
  typescript: {
    argv: [
      "npm",
      "install",
      "-g",
      "typescript-language-server",
      "typescript",
    ],
    hint: "npm install -g typescript-language-server typescript",
  },
  python: {
    argv: ["npm", "install", "-g", "pyright"],
    hint: "npm install -g pyright",
  },
  rust: {
    argv: ["rustup", "component", "add", "rust-analyzer"],
    hint: "rustup component add rust-analyzer",
  },
  go: {
    argv: ["go", "install", "golang.org/x/tools/gopls@latest"],
    hint: "go install golang.org/x/tools/gopls@latest",
  },
  swift: {
    argv: [],
    hint: "Install Xcode + SourceKit-LSP (macOS; no auto-install)",
    manualOnly: true,
    tip: "Swift: use Xcode toolchain / sourcekit-lsp — not auto-installed by Forge.",
  },
  json: {
    argv: ["npm", "install", "-g", "vscode-langservers-extracted"],
    hint: "npm install -g vscode-langservers-extracted",
  },
  yaml: {
    argv: ["npm", "install", "-g", "yaml-language-server"],
    hint: "npm install -g yaml-language-server",
  },
};

export function lspAutoEnsureEnabled(): boolean {
  const v = process.env.FORGE_LSP_AUTO?.trim().toLowerCase();
  if (!v) return true; // default on for init/REPL soft ensure
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

export function lspAutoInstallEnabled(): boolean {
  const v = process.env.FORGE_LSP_AUTO_INSTALL?.trim().toLowerCase();
  if (!v) return true;
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

export function buildEnsurePlan(workspace: string): EnsurePlan {
  const ws = path.resolve(workspace || process.cwd());
  const detected = detectProjectLanguages(ws);
  const ensureIds = new Set(languagesToEnsure(detected));

  const items: EnsurePlanItem[] = [];

  for (const d of detected) {
    const recipe = recipeForLanguage(d.languageId);
    const inst = INSTALL_ARGV[d.languageId];
    const command = recipe?.command || d.languageId;
    const onPath = commandOnPath(command);
    const shouldEnsure = ensureIds.has(d.languageId);
    const tier =
      d.tier === "default"
        ? "default"
        : shouldEnsure
          ? "project"
          : "optional";

    // Skip optional json/yaml from "ensure" noise unless already detected strongly
    if (
      !shouldEnsure &&
      (d.languageId === "json" || d.languageId === "yaml")
    ) {
      continue;
    }

    items.push({
      languageId: d.languageId,
      label: recipe?.label || d.languageId,
      command,
      onPath,
      tier: shouldEnsure ? (d.tier === "default" ? "default" : "project") : tier,
      reasons: d.reasons,
      installArgv: inst?.argv?.length ? inst.argv : undefined,
      installHint: inst?.hint || recipe?.install[0] || `install ${command}`,
      manualOnly: Boolean(inst?.manualOnly),
      tip: inst?.tip,
    });
  }

  // Shell tip (not an LSP)
  items.push({
    languageId: "shell",
    label: "Shell (no LSP)",
    command: "shellcheck",
    onPath: commandOnPath("shellcheck"),
    tier: "optional",
    reasons: ["prefer shellcheck over a shell language server"],
    installHint:
      process.platform === "darwin"
        ? "brew install shellcheck"
        : "apt install shellcheck  # or your package manager",
    manualOnly: true,
    tip: "Shell: use shellcheck (optional) — Forge does not auto-install a shell LSP.",
  });

  const toInstall = items.filter(
    (i) =>
      !i.onPath &&
      !i.manualOnly &&
      (i.tier === "default" || i.tier === "project") &&
      i.installArgv?.length,
  );
  const tips = items.filter(
    (i) => (!i.onPath && i.manualOnly) || (i.tip && !i.onPath),
  );
  const ready = items.filter(
    (i) => i.onPath && (i.tier === "default" || i.tier === "project"),
  );

  return { workspace: ws, detected, items, toInstall, tips, ready };
}

export async function ensureLspServers(opts: {
  workspace: string;
  /** Don't run installers — only plan */
  dryRun?: boolean;
  /** Only these language ids */
  only?: string[];
  /** Skip auto-install env gate (CLI explicit ensure) */
  forceInstall?: boolean;
  /** Timeout per install command ms */
  timeoutMs?: number;
  onLog?: (line: string) => void;
}): Promise<EnsureResult> {
  const plan = buildEnsurePlan(opts.workspace);
  let targets = plan.toInstall;
  if (opts.only?.length) {
    const set = new Set(opts.only.map((s) => s.toLowerCase()));
    targets = plan.items.filter(
      (i) =>
        set.has(String(i.languageId).toLowerCase()) &&
        !i.onPath &&
        !i.manualOnly &&
        i.installArgv?.length,
    );
  }

  const installed: string[] = [];
  const failed: Array<{ languageId: string; error: string }> = [];
  const skipped: string[] = [];
  const dryRun = Boolean(opts.dryRun);
  const canInstall =
    opts.forceInstall || (lspAutoInstallEnabled() && !dryRun);

  if (dryRun || !canInstall) {
    for (const t of targets) skipped.push(String(t.languageId));
    return { plan, installed, failed, skipped, dryRun: dryRun || !canInstall };
  }

  const timeoutMs = opts.timeoutMs ?? 180_000;
  for (const t of targets) {
    const argv = t.installArgv!;
    opts.onLog?.(
      `Installing ${t.label} (${t.command})…  $ ${argv.join(" ")}`,
    );
    try {
      // Prerequisites
      if (argv[0] === "npm" && !commandOnPath("npm")) {
        throw new Error("npm not on PATH — install Node.js first");
      }
      if (argv[0] === "rustup" && !commandOnPath("rustup")) {
        throw new Error(
          "rustup not on PATH — install from https://rustup.rs first",
        );
      }
      if (argv[0] === "go" && !commandOnPath("go")) {
        throw new Error("go not on PATH — install Go first");
      }
      await runInstall(argv, timeoutMs, opts.onLog);
      // Re-check PATH (npm global bin may need shell refresh — also check common bins)
      if (!commandOnPath(t.command)) {
        // npm global prefix/bin sometimes not in PATH of this process
        opts.onLog?.(
          `  note: ${t.command} may need a new shell if not found yet (npm prefix -g / PATH)`,
        );
      }
      installed.push(String(t.languageId));
      opts.onLog?.(`  ✓ ${t.label}`);
    } catch (err) {
      const msg = (err as Error).message || String(err);
      failed.push({ languageId: String(t.languageId), error: msg });
      opts.onLog?.(`  ✖ ${t.label}: ${msg.slice(0, 200)}`);
    }
  }

  // Refresh plan readiness after installs
  const finalPlan = buildEnsurePlan(opts.workspace);
  return {
    plan: finalPlan,
    installed,
    failed,
    skipped,
    dryRun: false,
  };
}

function runInstall(
  argv: string[],
  timeoutMs: number,
  onLog?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: createChildEnv(),
      shell: process.platform === "win32",
    });
    let errTail = "";
    child.stdout?.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      if (onLog) {
        for (const line of s.split(/\r?\n/).filter(Boolean).slice(-3)) {
          onLog(`    ${line.slice(0, 120)}`);
        }
      }
    });
    child.stderr?.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      errTail = (errTail + s).slice(-2000);
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* */
      }
      reject(new Error(`install timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `exit ${code}${errTail ? `: ${errTail.trim().slice(-300)}` : ""}`,
          ),
        );
      }
    });
  });
}

export function formatEnsurePlan(plan: EnsurePlan): string {
  const lines: string[] = [
    "LSP ensure plan",
    "───────────────",
    `Workspace: ${plan.workspace}`,
    "",
  ];
  if (plan.ready.length) {
    lines.push("Ready (on PATH):");
    for (const i of plan.ready) {
      lines.push(`  ✓ ${i.label}  \`${i.command}\``);
    }
    lines.push("");
  }
  if (plan.toInstall.length) {
    lines.push("Will install (missing):");
    for (const i of plan.toInstall) {
      lines.push(
        `  → ${i.label}  \`${i.command}\`  [${i.tier}]  $ ${i.installHint}`,
      );
      if (i.reasons[0]) lines.push(`      why: ${i.reasons[0]}`);
    }
    lines.push("");
  }
  if (plan.tips.length) {
    lines.push("Tips (not auto-installed):");
    for (const i of plan.tips) {
      lines.push(`  · ${i.tip || i.installHint}`);
    }
    lines.push("");
  }
  if (!plan.toInstall.length && plan.ready.length) {
    lines.push("Nothing to install for recommended languages.");
  } else if (!plan.toInstall.length) {
    lines.push(
      "No auto-installable servers missing. See /lsp install for full recipes.",
    );
  }
  lines.push(
    "Run: forge lsp ensure   ·   forge lsp ensure --dry-run   ·   FORGE_LSP_AUTO=0 to skip soft auto",
  );
  return lines.join("\n");
}

export function formatEnsureResult(result: EnsureResult): string {
  const lines: string[] = [formatEnsurePlan(result.plan), ""];
  if (result.dryRun) {
    lines.push("Dry-run / install disabled — no packages were installed.");
    if (result.skipped.length) {
      lines.push(`Would install: ${result.skipped.join(", ")}`);
    }
  } else {
    if (result.installed.length) {
      lines.push(`Installed: ${result.installed.join(", ")}`);
    }
    if (result.failed.length) {
      lines.push("Failed:");
      for (const f of result.failed) {
        lines.push(`  ✖ ${f.languageId}: ${f.error.slice(0, 160)}`);
      }
    }
    if (!result.installed.length && !result.failed.length) {
      lines.push("No installs needed.");
    }
  }
  lines.push(
    "Then: /lsp status  ·  lsp({ action: \"diagnostics\", path: \"…\" })",
  );
  return lines.join("\n");
}

// ── Soft ensure state (don't nag every turn) ──────────────────────

interface LspEnsureState {
  lastTipAt?: string;
  lastEnsureAt?: string;
  dismissedTip?: boolean;
}

function statePath(): string {
  return path.join(forgeHome(), "lsp-ensure.json");
}

export function loadLspEnsureState(): LspEnsureState {
  return readJsonFile<LspEnsureState>(statePath(), {});
}

export function saveLspEnsureState(state: LspEnsureState): void {
  try {
    ensureDir(forgeHome());
    writeJsonFile(statePath(), state, 0o600);
  } catch {
    /* */
  }
}

/**
 * One-line REPL tip when recommended servers are missing (at most once / 24h).
 */
export function maybeLspEnsureTip(workspace: string): string | null {
  if (!lspAutoEnsureEnabled()) return null;
  try {
    const st = loadLspEnsureState();
    if (st.dismissedTip) return null;
    if (st.lastTipAt) {
      const age = Date.now() - new Date(st.lastTipAt).getTime();
      if (Number.isFinite(age) && age < 24 * 60 * 60 * 1000) return null;
    }
    const plan = buildEnsurePlan(workspace);
    if (!plan.toInstall.length) return null;
    const names = plan.toInstall.map((i) => i.languageId).join(", ");
    st.lastTipAt = new Date().toISOString();
    saveLspEnsureState(st);
    return (
      `LSP: missing ${names} — run \`forge lsp ensure\` (or /lsp ensure) for a smooth install. ` +
      `FORGE_LSP_AUTO=0 silences this tip.`
    );
  } catch {
    return null;
  }
}

/**
 * Non-interactive ensure for forge init — installs default pack + project gates.
 * Best-effort; never throws.
 */
export async function ensureLspOnInit(
  workspace: string,
  opts?: { quiet?: boolean },
): Promise<EnsureResult | null> {
  if (!lspAutoEnsureEnabled() || !lspAutoInstallEnabled()) {
    return null;
  }
  try {
    const result = await ensureLspServers({
      workspace,
      forceInstall: true,
      onLog: opts?.quiet
        ? undefined
        : (line) => {
            log.dim(line);
          },
    });
    const st = loadLspEnsureState();
    st.lastEnsureAt = new Date().toISOString();
    saveLspEnsureState(st);
    return result;
  } catch {
    return null;
  }
}

/** Re-export guide for /lsp install when user wants recipes only. */
export function formatFullInstallGuide(workspace: string): string {
  const plan = buildEnsurePlan(workspace);
  const missing = new Set(
    plan.items.filter((i) => !i.onPath).map((i) => i.command),
  );
  return (
    formatEnsurePlan(plan) +
    "\n\n" +
    formatLspInstallGuide({ missingCommands: missing })
  );
}
