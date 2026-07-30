/**
 * OpenCode-inspired project skills.
 *
 * Load markdown skill packs from:
 *   <workspace>/.forge/skills/**\/SKILL.md
 *   <workspace>/.forge/skill/**\/SKILL.md
 *   <workspace>/.agents/skills/**\/SKILL.md
 *   ~/.forge/skills/**\/SKILL.md   (user global; project wins on name clash)
 *
 * Frontmatter (optional):
 *   ---
 *   name: my-skill
 *   description: When to use this skill
 *   ---
 *   Body instructions for the agent.
 *
 * Skills are injected into the system prompt as a catalog + bodies (capped)
 * so the model can follow project-specific playbooks without a separate tool.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome } from "../util/fs.js";

export interface ProjectSkill {
  /** Stable skill id (lowercase). */
  name: string;
  description: string;
  /** Skill body (markdown). */
  body: string;
  /** project | user */
  source: "project" | "user";
  /** Absolute path of SKILL.md. */
  filePath: string;
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_BODY_CHARS = 12_000;
const MAX_SKILLS = 24;
const MAX_PROMPT_CHARS = 24_000;

function parseFrontmatter(raw: string): {
  name?: string;
  description: string;
  body: string;
} {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    return { description: "", body: text.trim() };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { description: "", body: text.trim() };
  }
  const fm = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "").trim();
  let name: string | undefined;
  let description = "";
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (key === "name" && val) name = val;
    if (key === "description" && val) description = val;
  }
  return { name, description, body };
}

function walkSkillFiles(root: string, out: string[], depth = 0): void {
  if (depth > 6 || out.length >= 200) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      walkSkillFiles(full, out, depth + 1);
    } else if (ent.isFile() && ent.name.toLowerCase() === "skill.md") {
      out.push(full);
    }
  }
}

function skillDirs(base: string): string[] {
  return [
    path.join(base, ".forge", "skills"),
    path.join(base, ".forge", "skill"),
    path.join(base, ".agents", "skills"),
  ];
}

function loadFromDir(
  dir: string,
  source: "project" | "user",
  byName: Map<string, ProjectSkill>,
): void {
  if (!fs.existsSync(dir)) return;
  const files: string[] = [];
  walkSkillFiles(dir, files);
  files.sort();
  for (const filePath of files) {
    if (byName.size >= MAX_SKILLS) break;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (raw.length > MAX_BODY_CHARS * 2) {
      raw = raw.slice(0, MAX_BODY_CHARS * 2);
    }
    const parsed = parseFrontmatter(raw);
    // Default name: parent directory of SKILL.md
    const parent = path.basename(path.dirname(filePath));
    let name = (parsed.name || parent || "skill")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!NAME_RE.test(name)) continue;
    // Project wins: skip if already present from project when loading user
    if (byName.has(name) && source === "user") continue;
    if (byName.has(name) && source === "project") {
      // later project file with same name: first wins (sorted paths)
      continue;
    }
    let body = parsed.body || "";
    if (body.length > MAX_BODY_CHARS) {
      body = body.slice(0, MAX_BODY_CHARS) + "\n…(truncated)";
    }
    if (!body.trim()) continue;
    byName.set(name, {
      name,
      description: (parsed.description || "").slice(0, 300),
      body,
      source,
      filePath,
    });
  }
}

/**
 * Load project + user skills. Project overrides user on name clash.
 */
export function loadProjectSkills(workspace: string): ProjectSkill[] {
  const byName = new Map<string, ProjectSkill>();
  const ws = path.resolve(workspace || process.cwd());
  for (const dir of skillDirs(ws)) {
    loadFromDir(dir, "project", byName);
  }
  // User global (lower priority). forgeHome() is already ~/.forge
  try {
    const home = forgeHome();
    for (const dir of [
      path.join(home, "skills"),
      path.join(home, "skill"),
    ]) {
      loadFromDir(dir, "user", byName);
    }
  } catch {
    /* */
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Count only (doctor). */
export function countProjectSkills(workspace: string): number {
  try {
    return loadProjectSkills(workspace).length;
  } catch {
    return 0;
  }
}

/**
 * Format skills for system prompt injection. Caps total size.
 * Returns empty string when none.
 */
export function formatSkillsForPrompt(workspace: string): string {
  const skills = loadProjectSkills(workspace);
  if (!skills.length) return "";
  const lines: string[] = [
    `## Project skills`,
    `Use these playbooks when the task matches the description. Prefer the skill body over guessing project conventions.`,
    ``,
  ];
  let used = lines.join("\n").length;
  for (const s of skills) {
    const block =
      `### skill:${s.name}` +
      (s.description ? ` — ${s.description}` : "") +
      ` (${s.source})\n` +
      s.body.trim() +
      `\n`;
    if (used + block.length > MAX_PROMPT_CHARS) {
      lines.push(
        `…(${skills.length - lines.filter((l) => l.startsWith("### skill:")).length} more skills omitted — raise by trimming skill bodies)`,
      );
      break;
    }
    lines.push(block);
    used += block.length;
  }
  return lines.join("\n").trim();
}
