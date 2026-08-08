/**
 * OpenCode-inspired skills for Forge.
 *
 * Load order (later layers fill gaps; earlier wins on name clash):
 *   1. <workspace>/.forge/skills/**\/SKILL.md
 *   2. <workspace>/.forge/skill/**\/SKILL.md
 *   3. <workspace>/.agents/skills/**\/SKILL.md
 *   4. ~/.forge/skills/**\/SKILL.md  (user global)
 *   5. Package-shipped skills/ (builtin; FORGE_BUILTIN_SKILLS=0 to disable)
 *
 * Frontmatter (optional):
 *   ---
 *   name: my-skill
 *   description: When to use this skill
 *   inject: always | body | catalog   # default: body for project/user, catalog for builtin
 *   ---
 *   Body instructions for the agent.
 *
 * Prompt injection uses progressive disclosure:
 *   - Catalog of all skills (name, description, source, path)
 *   - Full bodies for project/user (+ any inject:always|body)
 *   - Builtins default to catalog-only; agent read_file(path) when matching
 * So install-time playbooks stay available without blowing the system prompt.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forgeHome } from "../util/fs.js";

export type SkillSource = "project" | "user" | "builtin";
export type SkillInject = "always" | "body" | "catalog";

export interface ProjectSkill {
  /** Stable skill id (lowercase). */
  name: string;
  description: string;
  /** Skill body (markdown). */
  body: string;
  source: SkillSource;
  /** Absolute path of SKILL.md. */
  filePath: string;
  /** How this skill enters the system prompt. */
  inject: SkillInject;
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_BODY_CHARS = 12_000;
/** Cap for project + user skills combined. */
const MAX_OVERLAY_SKILLS = 24;
/** Cap for package-shipped builtins. */
const MAX_BUILTIN_SKILLS = 32;
/** Total characters for inlined skill bodies in the system prompt. */
const MAX_PROMPT_CHARS = 24_000;

/**
 * Parse optional YAML frontmatter. Supports single-line scalars and simple
 * folded/block scalars (`>`, `>-`, `|`, `|-`) for description — OpenCode /
 * Claude skill packs commonly use `description: >-` multi-line form.
 */
function parseFrontmatter(raw: string): {
  name?: string;
  description: string;
  inject?: SkillInject;
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
  const fm = text.slice(3, end).replace(/^\r?\n/, "");
  const body = text.slice(end + 4).replace(/^\r?\n/, "").trim();
  let name: string | undefined;
  let description = "";
  let inject: SkillInject | undefined;

  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2].trim();

    // Multi-line YAML scalar: description: >-  /  |  /  >  /  |-
    if (
      (key === "description" || key === "name") &&
      /^(?:>-?|\|[-+]?)\s*$/.test(val)
    ) {
      const parts: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        // Indented continuation (or blank line inside the block)
        if (next === "" || /^\s+/.test(next) || next.startsWith("  ")) {
          i++;
          parts.push(next.replace(/^\s+/, ""));
          continue;
        }
        break;
      }
      // Folded `>` style: join with spaces; block `|` keeps newlines — we always
      // collapse description to one line for catalog matching.
      val = parts.join(" ").replace(/\s+/g, " ").trim();
    } else {
      val = val.replace(/^["']|["']$/g, "");
    }

    if (key === "name" && val) name = val;
    if (key === "description" && val) description = val;
    if (key === "inject") {
      const v = val.toLowerCase();
      if (v === "always" || v === "body" || v === "catalog") inject = v;
    }
  }
  return { name, description, inject, body };
}

/** Short path for catalog (home → ~; package skills → skills/…). */
function catalogPath(filePath: string): string {
  const pkgSkills = builtinSkillsDir() + path.sep;
  if (filePath.startsWith(pkgSkills) || filePath.startsWith(path.resolve(pkgSkills))) {
    return "skills/" + path.relative(builtinSkillsDir(), filePath).split(path.sep).join("/");
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && filePath.startsWith(home + path.sep)) {
    return "~" + filePath.slice(home.length);
  }
  return filePath;
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

/** Resolve package root (src/* or dist/* → repo/package root). */
export function forgePackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/agent or dist/agent → ../..
  return path.resolve(here, "../..");
}

/** Directory of ship-with-install skills (package `skills/`). */
export function builtinSkillsDir(): string {
  return path.join(forgePackageRoot(), "skills");
}

function builtinSkillsEnabled(): boolean {
  const raw = (process.env.FORGE_BUILTIN_SKILLS || "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function defaultInject(source: SkillSource, explicit?: SkillInject): SkillInject {
  if (explicit) return explicit;
  // Meta skill always inlined so the agent knows how to use the catalog.
  return source === "builtin" ? "catalog" : "body";
}

function loadFromDir(
  dir: string,
  source: SkillSource,
  byName: Map<string, ProjectSkill>,
  maxTotal: number,
): void {
  if (!fs.existsSync(dir)) return;
  const files: string[] = [];
  walkSkillFiles(dir, files);
  files.sort();
  for (const filePath of files) {
    if (byName.size >= maxTotal) break;
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
    const parent = path.basename(path.dirname(filePath));
    let name = (parsed.name || parent || "skill")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!NAME_RE.test(name)) continue;
    // First wins (project loaded first, then user, then builtin).
    if (byName.has(name)) continue;
    let body = parsed.body || "";
    if (body.length > MAX_BODY_CHARS) {
      body = body.slice(0, MAX_BODY_CHARS) + "\n…(truncated)";
    }
    if (!body.trim()) continue;
    // forge-method is the onboarding playbook — always inject body.
    let inject = defaultInject(source, parsed.inject);
    if (name === "forge-method" && source === "builtin") inject = "always";
    byName.set(name, {
      name,
      description: (parsed.description || "").slice(0, 400),
      body,
      source,
      filePath,
      inject,
    });
  }
}

/**
 * Load project + user + builtin skills.
 * Priority on name clash: project > user > builtin.
 */
export function loadProjectSkills(workspace: string): ProjectSkill[] {
  const byName = new Map<string, ProjectSkill>();
  const ws = path.resolve(workspace || process.cwd());
  for (const dir of skillDirs(ws)) {
    loadFromDir(dir, "project", byName, MAX_OVERLAY_SKILLS);
  }
  try {
    const home = forgeHome();
    for (const dir of [
      path.join(home, "skills"),
      path.join(home, "skill"),
    ]) {
      loadFromDir(dir, "user", byName, MAX_OVERLAY_SKILLS);
    }
  } catch {
    /* */
  }
  if (builtinSkillsEnabled()) {
    try {
      loadFromDir(
        builtinSkillsDir(),
        "builtin",
        byName,
        MAX_OVERLAY_SKILLS + MAX_BUILTIN_SKILLS,
      );
    } catch {
      /* */
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Count only (doctor / status). */
export function countProjectSkills(workspace: string): number {
  try {
    return loadProjectSkills(workspace).length;
  } catch {
    return 0;
  }
}

export function countBuiltinSkills(workspace?: string): number {
  try {
    return loadProjectSkills(workspace || process.cwd()).filter(
      (s) => s.source === "builtin",
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Format skills for system prompt injection.
 * Catalog always; full bodies for project/user and inject:always|body (budgeted).
 */
export function formatSkillsForPrompt(workspace: string): string {
  const skills = loadProjectSkills(workspace);
  if (!skills.length) return "";

  const pkgRoot = forgePackageRoot();
  const lines: string[] = [
    `## Skills`,
    `When a task matches a skill, read its path with \`read_file\` and follow it.`,
    `Builtin paths are under the Forge package root (\`${pkgRoot}\`); resolve \`skills/…\` against that root.`,
    `Project/user override builtin on name clash. Prefer skill body over guessing.`,
    ``,
    `### Catalog`,
  ];

  for (const s of skills) {
    const desc = (s.description || "(no description)").replace(/\s+/g, " ").slice(0, 120);
    const p = catalogPath(s.filePath);
    // One line per skill — keeps baseline prompt lean with 15+ builtins.
    lines.push(`- **${s.name}** [${s.source}] — ${desc} · \`${p}\``);
  }

  // Bodies to inline: always + body inject (project/user default body; forge-method always)
  const toInline = skills.filter(
    (s) => s.inject === "always" || s.inject === "body",
  );
  // Prefer project, then user, then builtin; within that, forge-method first
  toInline.sort((a, b) => {
    const rank = (s: ProjectSkill) =>
      s.name === "forge-method"
        ? 0
        : s.source === "project"
          ? 1
          : s.source === "user"
            ? 2
            : 3;
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });

  if (toInline.length) {
    lines.push(``, `### Inlined playbooks`);
  }

  let used = lines.join("\n").length;
  let inlined = 0;
  for (const s of toInline) {
    const block =
      `#### skill:${s.name}` +
      (s.description ? ` — ${s.description}` : "") +
      ` (${s.source})\n` +
      s.body.trim() +
      `\n`;
    if (used + block.length > MAX_PROMPT_CHARS) {
      const left = toInline.length - inlined;
      if (left > 0) {
        lines.push(
          `…(${left} more inlined skill body(ies) omitted — read from catalog path; trim SKILL.md bodies or raise budget)`,
        );
      }
      break;
    }
    lines.push(block);
    used += block.length;
    inlined++;
  }

  return lines.join("\n").trim();
}
