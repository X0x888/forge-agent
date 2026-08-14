/**
 * Shared `forge init` writers — CLI and `/setup scaffold` must not drift.
 */
import fs from "node:fs";
import path from "node:path";
import { defaultConfigToml } from "../config/load.js";
import { ensureDir, forgeHome } from "../util/fs.js";
import { log } from "../util/log.js";

export interface InitScaffoldResult {
  home: string;
  cwd: string;
  wrote: string[];
  existed: string[];
  lspEnsure: {
    installed: string[];
    failed: string[];
    ready: string[];
  } | null;
}

const AGENTS_STUB = `# AGENTS.md

Project instructions for Forge (and other coding agents).

## Build

- Install: \`npm install\`
- Build / typecheck / test: describe the real commands for this repo
- CI entrypoint if any

## Conventions

- Language, module system, style, architecture boundaries
- Non-obvious constraints (auth, migrations, generated code)

## Safety / production notes for agents

- Prefer small focused diffs; run the cheapest relevant check after edits
- Do not weaken fail-closed sandbox or commit secrets
- Long autonomous work: use ULW/\`/goal\` only when the user wants relentless execution
`;

function stopHookJson(): string {
  return (
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    "node -e " +
                    JSON.stringify(
                      `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);if(j.goalObjective&&!(j.lastAssistantMessage||'').includes('Goal achieved')){console.log(JSON.stringify({decision:'block',reason:'Goal still active — keep working: '+j.goalObjective.slice(0,200)}));}else{console.log(JSON.stringify({decision:'allow'}));}});`,
                    ),
                  timeout: 10,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n"
  );
}

export async function runForgeInit(opts?: {
  cwd?: string;
  quiet?: boolean;
}): Promise<InitScaffoldResult> {
  const cwd = path.resolve(opts?.cwd || process.cwd());
  const quiet = Boolean(opts?.quiet);
  const wrote: string[] = [];
  const existed: string[] = [];
  ensureDir(forgeHome());
  ensureDir(path.join(forgeHome(), "hooks"));
  ensureDir(path.join(forgeHome(), "sessions"));

  const homeCfg = path.join(forgeHome(), "config.toml");
  if (!fs.existsSync(homeCfg)) {
    fs.writeFileSync(homeCfg, defaultConfigToml(), "utf8");
    wrote.push(homeCfg);
    if (!quiet) log.success(`Wrote ${homeCfg}`);
  } else {
    existed.push(homeCfg);
    if (!quiet) log.info(`Exists: ${homeCfg}`);
  }

  const homeMcp = path.join(forgeHome(), "mcp.json");
  if (!fs.existsSync(homeMcp)) {
    const { defaultUserMcpJson } = await import("../mcp/config.js");
    fs.writeFileSync(homeMcp, defaultUserMcpJson(), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(homeMcp, 0o600);
    } catch {
      /* windows */
    }
    wrote.push(homeMcp);
    if (!quiet) {
      log.success(`Wrote ${homeMcp} (default MCP: context7 + playwright)`);
    }
  } else {
    existed.push(homeMcp);
    if (!quiet) log.info(`Exists: ${homeMcp}`);
  }

  const projectDir = path.join(cwd, ".forge");
  ensureDir(projectDir);
  ensureDir(path.join(projectDir, "hooks"));
  const stopHook = path.join(projectDir, "hooks", "stop-goal-example.json");
  if (!fs.existsSync(stopHook)) {
    fs.writeFileSync(stopHook, stopHookJson(), "utf8");
    wrote.push(stopHook);
    if (!quiet) log.success(`Wrote example Stop hook: ${stopHook}`);
  } else {
    existed.push(stopHook);
  }

  const agents = path.join(cwd, "AGENTS.md");
  if (!fs.existsSync(agents)) {
    fs.writeFileSync(agents, AGENTS_STUB, "utf8");
    wrote.push(agents);
    if (!quiet) log.success(`Wrote ${agents}`);
  } else {
    existed.push(agents);
    if (!quiet) log.info(`Exists: ${agents}`);
  }

  let lspEnsure: InitScaffoldResult["lspEnsure"] = null;
  try {
    const { ensureLspOnInit, buildEnsurePlan } = await import(
      "../lsp/ensure.js"
    );
    if (!quiet) {
      log.info(
        "LSP: ensuring TypeScript + Python servers (and project Rust/Go)…",
      );
    }
    const result = await ensureLspOnInit(cwd, { quiet });
    if (result) {
      lspEnsure = {
        installed: result.installed,
        failed: result.failed.map((f) => f.languageId),
        ready: result.plan.ready.map((r) => String(r.languageId)),
      };
      if (!quiet) {
        if (result.installed.length) {
          log.success(`LSP installed: ${result.installed.join(", ")}`);
        }
        if (result.failed.length) {
          log.warn(
            `LSP install failed: ${result.failed.map((f) => f.languageId).join(", ")} — forge lsp ensure`,
          );
        }
        if (!result.installed.length && !result.failed.length) {
          const plan = buildEnsurePlan(cwd);
          if (plan.ready.length) {
            log.dim(
              `LSP ready: ${plan.ready.map((r) => r.languageId).join(", ")}`,
            );
          }
        }
      }
    }
  } catch {
    /* never block init on LSP */
  }

  return {
    home: forgeHome(),
    cwd,
    wrote,
    existed,
    lspEnsure,
  };
}

export function formatInitScaffoldSummary(r: InitScaffoldResult): string {
  const lines = [
    `Scaffold  wrote ${r.wrote.length}  existed ${r.existed.length}`,
  ];
  for (const p of r.wrote) lines.push(`  + ${p}`);
  for (const p of r.existed) lines.push(`  · ${p}`);
  if (r.lspEnsure) {
    if (r.lspEnsure.installed.length) {
      lines.push(`  LSP installed: ${r.lspEnsure.installed.join(", ")}`);
    }
    if (r.lspEnsure.failed.length) {
      lines.push(`  LSP failed: ${r.lspEnsure.failed.join(", ")}`);
    }
    if (r.lspEnsure.ready.length) {
      lines.push(`  LSP ready: ${r.lspEnsure.ready.join(", ")}`);
    }
  }
  return lines.join("\n");
}
