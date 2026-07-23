import type { ForgeConfig } from "../config/types.js";
import type { GoalState } from "../harness/goal.js";
import fs from "node:fs";
import path from "node:path";

function loadProjectRules(workspace: string): string {
  const candidates = [
    "AGENTS.md",
    "FORGE.md",
    "CLAUDE.md",
    ".forge/rules.md",
  ];
  const chunks: string[] = [];
  for (const c of candidates) {
    const p = path.join(workspace, c);
    try {
      if (fs.existsSync(p)) {
        const text = fs.readFileSync(p, "utf8");
        if (text.trim()) chunks.push(`# From ${c}\n${text.trim().slice(0, 12_000)}`);
      }
    } catch {
      /* */
    }
  }
  return chunks.join("\n\n");
}

export function buildSystemPrompt(opts: {
  config: ForgeConfig;
  workspace: string;
  goal?: GoalState | null;
  ultrawork?: boolean;
}): string {
  const { config, workspace } = opts;
  const rules = loadProjectRules(workspace);

  const parts: string[] = [
    `You are Forge, an autonomous AI coding agent running in a terminal harness.`,
    ``,
    `## Workspace`,
    `Root: ${workspace}`,
    `Provider: ${config.provider}  Model: ${config.model}`,
    `Permission mode: ${config.permissionMode}`,
    ``,
    `## Operating principles`,
    `- Think before acting. Prefer verification (run tests, read files) over speculation.`,
    `- Make focused, correct changes. Explain why briefly when it matters.`,
    `- Use tools: bash, read_file, write_file, search_replace, grep, glob, todo_write.`,
    `- Prefer specialized file tools over bash for reads/edits.`,
    `- Track multi-step work with todo_write.`,
    `- Do not invent file contents — read them.`,
    ``,
    `## Harness (what makes Forge different from Grok Build)`,
    `- **Blocking Stop hooks**: when you try to finish a turn, Stop hooks may block you and force continuation with additional instructions. This is intentional — keep working.`,
    `- **/goal driver**: if a goal is active, you MUST keep working until you either (a) achieve it and attest **Goal achieved.** with a per-criterion checklist and evidence, or (b) hit a stuck-wall (auto-released). Do not stop early.`,
    `- **Ultrawork mode**: when active, open todos block Stop. Ship the mandate; do not defer remaining work to a future session.`,
    ``,
    `## Safety`,
    `- Never exfiltrate secrets. Never run destructive commands without necessity.`,
    `- Stay inside the workspace for writes.`,
    `- Force-push, rm -rf, drop database: avoid unless the user explicitly required it.`,
  ];

  if (config.permissionMode === "plan") {
    parts.push(
      ``,
      `## PLAN MODE`,
      `- You may read and search freely.`,
      `- Do NOT edit files or run mutating shell commands — propose a concrete plan instead.`,
      `- Structure: goal, steps, files touched, risks, verification.`,
    );
  }

  if (opts.ultrawork) {
    parts.push(
      ``,
      `## ULTRAWORK MODE ACTIVE`,
      `- Default to action after thinking. You own technical judgment.`,
      `- Do not stop with open todos or incomplete scope.`,
      `- Pause only for: missing credentials, hard external blockers, destructive shared-state without confirmation, unfamiliar in-progress state, or authorized scope explosion.`,
      `- No "I'll finish next session" — ship now.`,
    );
  }

  if (opts.goal && opts.goal.objective && !opts.goal.paused && opts.goal.status === "active") {
    parts.push(
      ``,
      `## ACTIVE GOAL (relentless driver armed)`,
      `Objective: ${opts.goal.objective}`,
      `Acceptance criteria:`,
      ...opts.goal.criteria.map((c, i) => `  ${i + 1}. ${c}`),
      `When complete: attest **Goal achieved.** with ✅/❌ per criterion + evidence.`,
      `The harness will block Stop until you do (or hit stuck-wall).`,
    );
  }

  if (rules) {
    parts.push(``, `## Project rules`, rules);
  }

  if (config.systemPromptExtra) {
    parts.push(``, `## Extra instructions`, config.systemPromptExtra);
  }

  return parts.join("\n");
}
