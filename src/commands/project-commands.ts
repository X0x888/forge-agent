/**
 * OpenCode-style project custom slash commands.
 *
 * Load markdown templates from:
 *   <workspace>/.forge/commands/*.md
 *   ~/.forge/commands/*.md   (user global; project wins on name clash)
 *
 * Frontmatter (optional YAML-ish):
 *   ---
 *   description: Short help text
 *   ---
 *   Body with $ARGUMENTS / $1..$9 placeholders.
 *
 * Invoking `/name args…` expands the template and forwards it as a user turn.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome } from "../util/fs.js";

export interface ProjectCommand {
  /** Slash name without leading slash (lowercase). */
  name: string;
  description: string;
  /** Template body (placeholders not yet expanded). */
  template: string;
  /** project | user */
  source: "project" | "user";
  /** Absolute path of the source file. */
  filePath: string;
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_TEMPLATE_CHARS = 32_000;
const MAX_COMMANDS = 64;

/** Built-in slash names that project commands must not shadow. */
const RESERVED = new Set([
  "help",
  "?",
  "quit",
  "exit",
  "q",
  "goal",
  "done",
  "pause",
  "unpause",
  "ulw",
  "ulw-off",
  "cycle",
  "max-waves",
  "max_waves",
  "hooks",
  "status",
  "statusline",
  "hud",
  "tasks",
  "context",
  "cost",
  "budget",
  "metrics",
  "stats",
  "todos",
  "model",
  "effort",
  "plan",
  "build",
  "execute",
  "permissions",
  "compact",
  "compact-and",
  "fork-and-compact",
  "init",
  "review",
  "rewind",
  "undo",
  "retry",
  "again",
  "export",
  "fork",
  "title",
  "rename",
  "bell",
  "notify",
  "format",
  "pin",
  "unpin",
  "diff",
  "copy",
  "share",
  "last",
  "files",
  "path",
  "logs",
  "config",
  "tips",
  "news",
  "changelog",
  "new",
  "clear",
  "resume",
  "sessions",
  "auth",
  "accounts",
  "account",
  "doctor",
  "commands",
  "skills",
]);

function parseFrontmatter(raw: string): {
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
  let description = "";
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^description\s*:\s*(.+)$/i);
    if (m) {
      description = m[1].trim().replace(/^["']|["']$/g, "");
      break;
    }
  }
  return { description, body };
}

function loadDir(
  dir: string,
  source: "project" | "user",
  into: Map<string, ProjectCommand>,
): void {
  let entries: string[];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!/\.md$/i.test(ent)) continue;
    const base = ent.replace(/\.md$/i, "").toLowerCase();
    if (!NAME_RE.test(base)) continue;
    if (RESERVED.has(base)) continue;
    // Project wins: skip if already loaded
    if (into.has(base)) continue;
    if (into.size >= MAX_COMMANDS) break;
    const filePath = path.join(dir, ent);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      if (!raw.trim()) continue;
      const { description, body } = parseFrontmatter(raw);
      if (!body) continue;
      const template =
        body.length > MAX_TEMPLATE_CHARS
          ? body.slice(0, MAX_TEMPLATE_CHARS)
          : body;
      into.set(base, {
        name: base,
        description:
          description ||
          (source === "project"
            ? `Project command (.forge/commands/${ent})`
            : `User command (~/.forge/commands/${ent})`),
        template,
        source,
        filePath,
      });
    } catch {
      /* */
    }
  }
}

/**
 * Discover custom commands for a workspace (project first, then user global).
 */
export function loadProjectCommands(workspace: string): ProjectCommand[] {
  const map = new Map<string, ProjectCommand>();
  const ws = path.resolve(workspace || process.cwd());
  loadDir(path.join(ws, ".forge", "commands"), "project", map);
  try {
    loadDir(path.join(forgeHome(), "commands"), "user", map);
  } catch {
    /* */
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findProjectCommand(
  workspace: string,
  name: string,
): ProjectCommand | undefined {
  const bare = name.replace(/^\//, "").toLowerCase().trim();
  if (!bare || RESERVED.has(bare)) return undefined;
  return loadProjectCommands(workspace).find((c) => c.name === bare);
}

/**
 * Expand $ARGUMENTS / $1..$9 placeholders (OpenCode-compatible).
 */
export function expandProjectCommandTemplate(
  template: string,
  args: string,
): string {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  let out = template;
  // Numbered first so $10 is not partially eaten by $1
  for (let i = 9; i >= 1; i--) {
    const val = parts[i - 1] ?? "";
    out = out.split(`$${i}`).join(val);
  }
  out = out.split("$ARGUMENTS").join(args.trim());
  // Common aliases
  out = out.split("$ARGS").join(args.trim());
  return out.trim();
}

/** Slash names (with leading /) for completion + typo recovery. */
export function listProjectCommandSlashes(workspace: string): string[] {
  return loadProjectCommands(workspace).map((c) => `/${c.name}`);
}

export function formatProjectCommandsHelp(workspace: string): string {
  const cmds = loadProjectCommands(workspace);
  if (!cmds.length) {
    return (
      "No project commands.\n" +
      "  Add markdown templates under .forge/commands/<name>.md\n" +
      "  Optional frontmatter: description: …\n" +
      "  Body placeholders: $ARGUMENTS  $1..$9\n" +
      "  User-global: ~/.forge/commands/"
    );
  }
  return (
    "Project / user commands:\n" +
    cmds
      .map(
        (c) =>
          `  /${c.name.padEnd(16)} ${c.description.slice(0, 60)}${
            c.source === "user" ? "  (user)" : ""
          }`,
      )
      .join("\n") +
    "\n  (from .forge/commands/*.md · ~/.forge/commands/*.md)"
  );
}

export function isReservedSlashName(name: string): boolean {
  return RESERVED.has(name.replace(/^\//, "").toLowerCase());
}
