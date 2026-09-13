/**
 * Coarse product kind from the tree — never the user prompt.
 *
 * ULW inlines one matching category skill on Planner/Reviewer. A laundry-list
 * mandate must not pick the skill (HashPet's prompt once would have). Keep the
 * labels few and the signals conservative; do not grow this into another
 * detectProjectHints.
 */
import fs from "node:fs";
import path from "node:path";

export type ProductKind = "game" | "web" | "cli" | "library" | "unknown";

export const CATEGORY_SKILL = {
  game: "forge-game-assets",
  web: "forge-surface",
  cli: "forge-shape",
  library: "forge-prove",
} as const satisfies Record<Exclude<ProductKind, "unknown">, string>;

const WEB_CONFIGS = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "next.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
] as const;

const FRONTEND_LOCKS = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
] as const;

const EXTENSION_MANIFESTS = [
  "manifest.json",
  "extension/manifest.json",
  "src/manifest.json",
] as const;

export function categorySkillForKind(kind: ProductKind): string | undefined {
  if (kind === "unknown") return undefined;
  return CATEGORY_SKILL[kind];
}

export function categorySkillFor(workspace: string): string | undefined {
  return categorySkillForKind(detectProductKind(workspace));
}

/** Skills inlined into Planner / Reviewer. Kind comes from the tree. */
export function ulwRoleInlineSkills(
  role: "planner" | "reviewer",
  workspace: string,
): string[] {
  const skills = [
    role === "planner" ? "forge-planner" : "forge-reviewer",
    "forge-veteran",
    "forge-rootcause",
  ];
  const cat = categorySkillFor(workspace);
  if (cat) skills.push(cat);
  return skills;
}

export function detectProductKind(workspace: string): ProductKind {
  if (!workspace) return "unknown";
  if (isGame(workspace)) return "game";
  if (isWeb(workspace)) return "web";
  if (isCli(workspace)) return "cli";
  if (isLibrary(workspace)) return "library";
  return "unknown";
}

function isGame(root: string): boolean {
  if (exists(root, "project.godot")) return true;
  if (exists(root, "ProjectSettings/ProjectVersion.txt")) return true;
  if (isDir(root, "Assets") && isDir(root, "ProjectSettings")) return true;
  if (hasSuffixFile(root, ".uproject")) return true;
  if (exists(root, "Config/DefaultEngine.ini")) return true;
  for (const rel of EXTENSION_MANIFESTS) {
    const m = readJson(root, rel);
    if (m && (m.browser_action != null || m.action != null)) return true;
  }
  return false;
}

function isWeb(root: string): boolean {
  // A bin is a CLI even when Vite/Next sits beside it (docs site, playground).
  if (hasBin(readPkg(root))) return false;
  if (WEB_CONFIGS.some((f) => exists(root, f))) return true;
  if (exists(root, "index.html") && hasFrontendLock(root)) return true;
  return false;
}

function isCli(root: string): boolean {
  if (hasBin(readPkg(root))) return true;
  if (exists(root, "Cargo.toml") && cargoLooksBinary(root)) return true;
  if (exists(root, "go.mod") && isDir(root, "cmd")) return true;
  return false;
}

function isLibrary(root: string): boolean {
  const pkg = readPkg(root);
  return Boolean(pkg && hasExports(pkg) && !hasBin(pkg));
}

function cargoLooksBinary(root: string): boolean {
  if (exists(root, "src/main.rs") || isDir(root, "src/bin")) return true;
  try {
    const toml = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
    return /^\s*\[\[bin\]\]/m.test(toml);
  } catch {
    return false;
  }
}

function hasFrontendLock(root: string): boolean {
  return FRONTEND_LOCKS.some((f) => exists(root, f));
}

function hasBin(pkg: Record<string, unknown> | undefined): boolean {
  if (!pkg) return false;
  const bin = pkg.bin;
  if (typeof bin === "string") return bin.trim().length > 0;
  if (bin && typeof bin === "object" && !Array.isArray(bin)) {
    return Object.keys(bin as object).length > 0;
  }
  return false;
}

function hasExports(pkg: Record<string, unknown>): boolean {
  const e = pkg.exports;
  if (typeof e === "string") return e.trim().length > 0;
  if (e && typeof e === "object") return Object.keys(e as object).length > 0;
  return false;
}

function readPkg(root: string): Record<string, unknown> | undefined {
  return readJson(root, "package.json");
}

function readJson(root: string, rel: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(path.join(root, rel), "utf8");
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* missing or unreadable is not a kind */
  }
  return undefined;
}

function exists(root: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(root, rel));
  } catch {
    return false;
  }
}

function isDir(root: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

function hasSuffixFile(root: string, suffix: string): boolean {
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.endsWith(suffix)) return true;
    }
  } catch {
    /* */
  }
  return false;
}
