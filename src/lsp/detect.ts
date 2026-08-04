/**
 * Project language detection for LSP ensure / install recommendations.
 * Lightweight: only checks config files + a shallow extension sample.
 */
import fs from "node:fs";
import path from "node:path";

export type DetectedLanguageId =
  | "typescript"
  | "python"
  | "rust"
  | "go"
  | "swift"
  | "json"
  | "yaml";

export interface ProjectLanguageSignals {
  languageId: DetectedLanguageId;
  /** Why we think this language is present */
  reasons: string[];
  /** Always recommend (TS/Python) vs only when project signals */
  tier: "default" | "project";
}

const CONFIG_MARKERS: Array<{
  languageId: DetectedLanguageId;
  files: string[];
  tier: "default" | "project";
  reason: string;
}> = [
  {
    languageId: "typescript",
    files: [
      "tsconfig.json",
      "jsconfig.json",
      "package.json",
      "pnpm-workspace.yaml",
      "turbo.json",
    ],
    tier: "default",
    reason: "JS/TS project markers",
  },
  {
    languageId: "python",
    files: [
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "poetry.lock",
      "environment.yml",
    ],
    tier: "default",
    reason: "Python project markers",
  },
  {
    languageId: "rust",
    files: ["Cargo.toml", "Cargo.lock"],
    tier: "project",
    reason: "Rust crate markers",
  },
  {
    languageId: "go",
    files: ["go.mod", "go.sum"],
    tier: "project",
    reason: "Go module markers",
  },
  {
    languageId: "swift",
    files: ["Package.swift", "Package.resolved"],
    tier: "project",
    reason: "Swift package markers",
  },
];

const EXT_TO_LANG: Record<string, DetectedLanguageId> = {
  ts: "typescript",
  tsx: "typescript",
  js: "typescript",
  jsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  swift: "swift",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
};

/**
 * Detect languages present in workspace.
 * Always includes typescript + python as "default" tier recommendations
 * (they are the bottom-line pack) even without markers — callers use
 * `tier` to decide auto-install vs project-gated.
 */
export function detectProjectLanguages(workspace: string): ProjectLanguageSignals[] {
  const root = path.resolve(workspace || process.cwd());
  const byId = new Map<DetectedLanguageId, ProjectLanguageSignals>();

  const add = (
    languageId: DetectedLanguageId,
    tier: "default" | "project",
    reason: string,
  ) => {
    const prev = byId.get(languageId);
    if (prev) {
      if (!prev.reasons.includes(reason)) prev.reasons.push(reason);
      // Promote project → still project; keep default if already default
      if (tier === "default") prev.tier = "default";
      return;
    }
    byId.set(languageId, { languageId, tier, reasons: [reason] });
  };

  // Config markers
  for (const m of CONFIG_MARKERS) {
    for (const f of m.files) {
      if (fileExists(path.join(root, f))) {
        add(m.languageId, m.tier, `${m.reason} (${f})`);
        break;
      }
    }
  }

  // package.json engines / deps hint for TS even without tsconfig
  try {
    const pkgPath = path.join(root, "package.json");
    if (fs.existsSync(pkgPath)) {
      const raw = fs.readFileSync(pkgPath, "utf8");
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      if (
        deps.typescript ||
        deps["@types/node"] ||
        deps.tsx ||
        deps.vite ||
        deps.next
      ) {
        add("typescript", "default", "package.json TypeScript-related deps");
      }
    }
  } catch {
    /* */
  }

  // Shallow walk for extensions (cap files for speed)
  const extHits = sampleExtensions(root, 400);
  for (const [ext, count] of extHits) {
    const lang = EXT_TO_LANG[ext];
    if (!lang || count < 1) continue;
    const tier: "default" | "project" =
      lang === "typescript" || lang === "python" ? "default" : "project";
    add(lang, tier, `${count} *.${ext} file(s)`);
  }

  // Bottom-line defaults: always recommend TS + Python as install targets
  // even on empty repos (smooth path for greenfield agent work).
  if (!byId.has("typescript")) {
    add("typescript", "default", "default pack (JS/TS agents)");
  }
  if (!byId.has("python")) {
    add("python", "default", "default pack (Python agents)");
  }

  const order: DetectedLanguageId[] = [
    "typescript",
    "python",
    "rust",
    "go",
    "swift",
    "json",
    "yaml",
  ];
  return order
    .filter((id) => byId.has(id))
    .map((id) => byId.get(id)!);
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** BFS sample of file extensions under root (skips node_modules, .git, …). */
function sampleExtensions(
  root: string,
  maxFiles: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  const skipDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    ".next",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    "coverage",
    ".forge",
    ".tmp",
  ]);
  const queue: string[] = [root];
  let seen = 0;
  while (queue.length && seen < maxFiles) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (seen >= maxFiles) break;
      if (ent.name.startsWith(".") && ent.name !== ".github") {
        if (ent.isDirectory()) continue;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        queue.push(full);
      } else if (ent.isFile()) {
        seen += 1;
        const ext = path.extname(ent.name).slice(1).toLowerCase();
        if (!ext) continue;
        counts.set(ext, (counts.get(ext) || 0) + 1);
      }
    }
  }
  return counts;
}

/** Languages that should auto-install when missing (default pack + detected project). */
export function languagesToEnsure(
  detected: ProjectLanguageSignals[],
  opts?: { includeProject?: boolean },
): DetectedLanguageId[] {
  const includeProject = opts?.includeProject !== false;
  const out: DetectedLanguageId[] = [];
  for (const d of detected) {
    if (d.tier === "default") out.push(d.languageId);
    else if (includeProject && d.tier === "project") {
      // Auto-install only rust/go when project signals — not swift (platform)
      // and not json/yaml (optional polish)
      if (d.languageId === "rust" || d.languageId === "go") {
        out.push(d.languageId);
      }
    }
  }
  return out;
}
