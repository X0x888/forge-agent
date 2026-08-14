/**
 * Project intelligence — detect package manager + preferred check commands
 * so the agent verifies with the right tool without rediscovering the stack.
 *
 * High-leverage for less user steering: experts should not have to say
 * "use pnpm" or "the test script is npm run check".
 */
import fs from "node:fs";
import path from "node:path";
import { detectProjectHints } from "./git-context.js";
import { editDistance } from "./string-distance.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type ProjectIntel = {
  /** Ecosystem labels (node, typescript, rust, monorepo, …). */
  kinds: string[];
  packageManager?: PackageManager;
  packageName?: string;
  packageVersion?: string;
  /**
   * Preferred verification commands, cheapest / most common first.
   * Empty when no project markers found.
   */
  checkCommands: string[];
  /**
   * Workspace package directory globs or resolved package names (monorepo).
   * Empty when not a workspace root.
   */
  workspaces: string[];
  /**
   * Monorepo root when cwd is a nested package (walk-up). Same as cwd when
   * already at the workspace root or no monorepo markers found.
   */
  monorepoRoot?: string;
  /** Compact one-liner for banners / status. */
  summary: string;
};

const SCRIPT_PRIORITY = [
  "typecheck",
  "test",
  "lint",
  "check",
  "build",
  "smoke",
  "ci",
] as const;

/** Short TTL so post-edit verify tips stay cheap without going stale forever. */
const INTEL_CACHE_TTL_MS = 5_000;
const intelCache = new Map<
  string,
  { at: number; fingerprint: string; value: ProjectIntel }
>();

function exists(cwd: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(cwd, rel));
  } catch {
    return false;
  }
}

/** Cheap fingerprint of stack markers (mtime/size) for cache invalidation. */
function stackFingerprint(root: string): string {
  const markers = [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    ".yarnrc.yml",
    "bun.lock",
    "bun.lockb",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "pytest.ini",
    "Gemfile",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "mix.exs",
    "composer.json",
    "Makefile",
    "tsconfig.json",
    "turbo.json",
    "nx.json",
  ];
  const parts: string[] = [];
  for (const m of markers) {
    try {
      const st = fs.statSync(path.join(root, m));
      parts.push(`${m}:${st.mtimeMs}:${st.size}`);
    } catch {
      /* missing */
    }
  }
  return parts.join("|");
}

/** Test helper — drop cached fingerprints. */
export function clearProjectIntelCache(): void {
  intelCache.clear();
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* */
  }
  return null;
}

/**
 * Prefer lockfile, then package.json packageManager field, else npm.
 * When `opts.walkUp` is true (default for nested packages), also check parent
 * monorepo roots so a package without its own lockfile inherits pnpm/yarn/bun.
 */
export function detectPackageManager(
  cwd: string,
  opts?: { walkUp?: boolean },
): PackageManager | undefined {
  const root = path.resolve(cwd || process.cwd());
  const walkUp = opts?.walkUp !== false;

  const fromDir = (dir: string): PackageManager | undefined => {
    if (exists(dir, "pnpm-lock.yaml") || exists(dir, "pnpm-workspace.yaml")) {
      return "pnpm";
    }
    if (exists(dir, "yarn.lock") || exists(dir, ".yarnrc.yml")) {
      return "yarn";
    }
    if (exists(dir, "bun.lockb") || exists(dir, "bun.lock")) {
      return "bun";
    }
    if (exists(dir, "package-lock.json") || exists(dir, "npm-shrinkwrap.json")) {
      return "npm";
    }
    const pkg = readJson(path.join(dir, "package.json"));
    const field =
      typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
    const id = field.split("@")[0]?.trim().toLowerCase();
    if (id === "pnpm" || id === "yarn" || id === "bun" || id === "npm") {
      return id;
    }
    return undefined;
  };

  // Strong local signal (lockfile / packageManager field) wins.
  const localStrong = (() => {
    if (
      exists(root, "pnpm-lock.yaml") ||
      exists(root, "pnpm-workspace.yaml") ||
      exists(root, "yarn.lock") ||
      exists(root, ".yarnrc.yml") ||
      exists(root, "bun.lockb") ||
      exists(root, "bun.lock") ||
      exists(root, "package-lock.json") ||
      exists(root, "npm-shrinkwrap.json")
    ) {
      return fromDir(root);
    }
    const pkg = readJson(path.join(root, "package.json"));
    const field =
      typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
    const id = field.split("@")[0]?.trim().toLowerCase();
    if (id === "pnpm" || id === "yarn" || id === "bun" || id === "npm") {
      return id as PackageManager;
    }
    return undefined;
  })();
  if (localStrong) return localStrong;

  if (walkUp) {
    const mono = findMonorepoRoot(root);
    if (mono && mono !== root) {
      const parentPm = fromDir(mono);
      if (parentPm) return parentPm;
    }
  }

  // Bare package.json with no lockfile → npm default (legacy).
  if (exists(root, "package.json")) return "npm";
  return undefined;
}

/**
 * Detect npm/pnpm/yarn/bun workspace package dirs (best-effort, capped).
 * Returns short labels suitable for prompt/status (dir basenames or globs).
 */
export function detectWorkspaces(cwd: string): string[] {
  const root = path.resolve(cwd || process.cwd());
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (label: string) => {
    const s = label.trim().replace(/\\/g, "/");
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  // pnpm-workspace.yaml packages: [...]
  try {
    const yamlPath = path.join(root, "pnpm-workspace.yaml");
    if (fs.existsSync(yamlPath)) {
      const raw = fs.readFileSync(yamlPath, "utf8");
      for (const m of raw.matchAll(/^\s*-\s*['"]?([^'"#\n]+)['"]?\s*$/gm)) {
        const g = m[1]?.trim();
        if (g && !g.startsWith("catalog")) push(g);
      }
    }
  } catch {
    /* */
  }

  // package.json workspaces: string[] | { packages: string[] }
  try {
    const pkg = readJson(path.join(root, "package.json"));
    const ws = pkg?.workspaces;
    let globs: string[] = [];
    if (Array.isArray(ws)) {
      globs = ws.filter((x): x is string => typeof x === "string");
    } else if (ws && typeof ws === "object" && !Array.isArray(ws)) {
      const packs = (ws as { packages?: unknown }).packages;
      if (Array.isArray(packs)) {
        globs = packs.filter((x): x is string => typeof x === "string");
      }
    }
    for (const g of globs) push(g);
  } catch {
    /* */
  }

  // Resolve simple single-segment globs like packages/* into real dir names
  // (helps the agent target packages/core without listing the whole tree).
  const resolved: string[] = [];
  for (const g of out) {
    if (!g.includes("*")) {
      resolved.push(g);
      continue;
    }
    // Only expand one trailing /* for safety.
    const m = g.match(/^([^*]+)\*$/);
    if (!m) {
      resolved.push(g);
      continue;
    }
    const base = m[1].replace(/\/$/, "");
    try {
      const abs = path.join(root, base);
      const ents = fs.readdirSync(abs, { withFileTypes: true });
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith(".")) continue;
        // Prefer package name when package.json exists.
        try {
          const p = readJson(path.join(abs, e.name, "package.json"));
          if (typeof p?.name === "string" && p.name.trim()) {
            resolved.push(`${base}/${e.name} (${p.name.trim()})`);
            continue;
          }
        } catch {
          /* */
        }
        resolved.push(`${base}/${e.name}`);
      }
    } catch {
      resolved.push(g);
    }
  }

  // Cap for prompt lean-ness.
  return resolved.slice(0, 12);
}

function runScript(pm: PackageManager, script: string): string {
  // `npm test` / `npm start` are special; others need `run`.
  if (pm === "npm") {
    if (script === "test" || script === "start") return `npm ${script}`;
    return `npm run ${script}`;
  }
  if (pm === "yarn") {
    // yarn v1: yarn test; yarn v2+ also accepts yarn run test
    if (script === "test" || script === "start") return `yarn ${script}`;
    return `yarn ${script}`;
  }
  if (pm === "pnpm") {
    if (script === "test" || script === "start") return `pnpm ${script}`;
    return `pnpm run ${script}`;
  }
  // bun
  if (script === "test" || script === "start") return `bun ${script}`;
  return `bun run ${script}`;
}

function nodeCheckCommands(
  cwd: string,
  pm: PackageManager,
): string[] {
  const pkg = readJson(path.join(cwd, "package.json"));
  const scripts =
    pkg?.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of SCRIPT_PRIORITY) {
    if (typeof scripts[name] !== "string" || !String(scripts[name]).trim()) {
      continue;
    }
    const cmd = runScript(pm, name);
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    out.push(cmd);
  }
  return out;
}

function otherEcosystemCommands(cwd: string, kinds: string[]): string[] {
  const out: string[] = [];
  const has = (k: string) => kinds.includes(k);

  if (has("rust") || exists(cwd, "Cargo.toml")) {
    out.push("cargo check", "cargo test");
  }
  if (has("go") || exists(cwd, "go.mod")) {
    out.push("go test ./...");
  }
  if (has("python") || exists(cwd, "pyproject.toml") || exists(cwd, "requirements.txt")) {
    if (exists(cwd, "pytest.ini") || exists(cwd, "conftest.py")) {
      out.push("pytest");
    } else if (exists(cwd, "pyproject.toml")) {
      // Many modern Python projects use pytest via pyproject; still the default.
      out.push("pytest");
    } else {
      out.push("python -m pytest");
    }
  }
  if (has("ruby") || exists(cwd, "Gemfile")) {
    out.push("bundle exec rspec", "bundle exec rake test");
  }
  if (
    has("java") ||
    exists(cwd, "pom.xml") ||
    exists(cwd, "build.gradle") ||
    exists(cwd, "build.gradle.kts")
  ) {
    if (exists(cwd, "pom.xml")) out.push("mvn -q test");
    else out.push("./gradlew test");
  }
  if (has("elixir") || exists(cwd, "mix.exs")) {
    out.push("mix test");
  }
  if (has("php") || exists(cwd, "composer.json")) {
    out.push("composer test", "./vendor/bin/phpunit");
  }
  // Makefile last — only when no higher-signal stack commands yet.
  if ((has("make") || exists(cwd, "Makefile")) && out.length === 0) {
    out.push("make test", "make check");
  }
  return out;
}

/**
 * Walk up from cwd looking for monorepo root markers (workspaces / turbo / nx).
 * Stops at filesystem root, git root (when present), or after 8 parents.
 * Returns null when cwd itself is the monorepo root or nothing is found.
 * Bounding to git root prevents inheriting an unrelated parent monorepo
 * outside the current repository.
 */
export function findMonorepoRoot(cwd: string): string | null {
  const start = path.resolve(cwd || process.cwd());
  // Bound walk to git root when available (best-effort).
  let gitBound: string | null = null;
  try {
    let d = start;
    for (let i = 0; i < 12; i++) {
      if (exists(d, ".git")) {
        gitBound = d;
        break;
      }
      const p = path.dirname(d);
      if (p === d) break;
      d = p;
    }
  } catch {
    gitBound = null;
  }

  let dir = start;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    // Do not walk above git root.
    if (gitBound && parent.length < gitBound.length) break;
    if (gitBound && !parent.startsWith(gitBound) && parent !== gitBound) break;
    dir = parent;
    if (
      exists(dir, "pnpm-workspace.yaml") ||
      exists(dir, "turbo.json") ||
      exists(dir, "nx.json")
    ) {
      return dir;
    }
    // package.json workspaces field
    try {
      const pkg = readJson(path.join(dir, "package.json"));
      const ws = pkg?.workspaces;
      if (Array.isArray(ws) && ws.length) return dir;
      if (
        ws &&
        typeof ws === "object" &&
        !Array.isArray(ws) &&
        Array.isArray((ws as { packages?: unknown }).packages) &&
        ((ws as { packages: unknown[] }).packages?.length || 0) > 0
      ) {
        return dir;
      }
    } catch {
      /* */
    }
    if (gitBound && dir === gitBound) break;
  }
  return null;
}

/**
 * Fingerprint the workspace for verification commands + stack labels.
 * Best-effort and sync (banner / system prompt / post-edit tip path).
 * Cached ~5s per cwd, invalidated when stack marker mtimes change.
 * When cwd is a nested monorepo package, merges root workspaces/checks.
 */
export function detectProjectIntel(cwd: string): ProjectIntel {
  const root = path.resolve(cwd || process.cwd());
  const monoRoot = findMonorepoRoot(root);
  const cacheKey = monoRoot ? `${root}::${monoRoot}` : root;
  const fp =
    stackFingerprint(root) +
    (monoRoot ? `|mono:${stackFingerprint(monoRoot)}` : "");
  const hit = intelCache.get(cacheKey);
  if (hit && hit.fingerprint === fp && Date.now() - hit.at < INTEL_CACHE_TTL_MS) {
    return hit.value;
  }
  let value = detectProjectIntelUncached(root);
  if (monoRoot && monoRoot !== root) {
    const parent = detectProjectIntelUncached(monoRoot);
    // Prefer local package name/version/scripts first, then root monorepo checks.
    const kinds = [...value.kinds];
    for (const k of parent.kinds) {
      if (!kinds.includes(k)) kinds.push(k);
    }
    if (!kinds.includes("monorepo")) kinds.push("monorepo");
    const checkCommands: string[] = [];
    const seen = new Set<string>();
    for (const c of [...value.checkCommands, ...parent.checkCommands]) {
      if (seen.has(c)) continue;
      seen.add(c);
      checkCommands.push(c);
    }
    const workspaces =
      parent.workspaces.length > 0 ? parent.workspaces : value.workspaces;
    const pm = value.packageManager || parent.packageManager;
    const bits: string[] = [];
    if (value.packageName) {
      bits.push(
        value.packageVersion
          ? `${value.packageName}@${value.packageVersion}`
          : value.packageName,
      );
    } else if (parent.packageName) {
      bits.push(parent.packageName);
    }
    if (pm) bits.push(pm);
    if (kinds.length) bits.push(kinds.join("+"));
    bits.push(`root=${path.basename(monoRoot)}`);
    if (checkCommands.length) {
      bits.push(`checks: ${checkCommands.slice(0, 4).join(" · ")}`);
    }
    value = {
      kinds,
      packageManager: pm,
      packageName: value.packageName || parent.packageName,
      packageVersion: value.packageVersion || parent.packageVersion,
      checkCommands: checkCommands.slice(0, 8),
      workspaces,
      monorepoRoot: monoRoot,
      summary: bits.join(" · "),
    };
  } else if (
    value.workspaces.length ||
    value.kinds.includes("monorepo") ||
    value.kinds.includes("turbo") ||
    value.kinds.includes("nx")
  ) {
    value = { ...value, monorepoRoot: root };
  }
  intelCache.set(cacheKey, { at: Date.now(), fingerprint: fp, value });
  // Bound map size (long-lived REPL switching workspaces).
  if (intelCache.size > 32) {
    const oldest = intelCache.keys().next().value;
    if (oldest !== undefined) intelCache.delete(oldest);
  }
  return value;
}

function detectProjectIntelUncached(root: string): ProjectIntel {
  const kinds = [...detectProjectHints(root)];
  const pm = detectPackageManager(root);
  const workspaces = detectWorkspaces(root);
  if (workspaces.length && !kinds.includes("monorepo")) {
    kinds.push("monorepo");
  }
  let packageName: string | undefined;
  let packageVersion: string | undefined;
  try {
    const pkg = readJson(path.join(root, "package.json"));
    if (typeof pkg?.name === "string" && pkg.name.trim()) {
      packageName = pkg.name.trim().slice(0, 120);
    }
    if (typeof pkg?.version === "string" && pkg.version.trim()) {
      packageVersion = pkg.version.trim().slice(0, 40);
    }
  } catch {
    /* */
  }

  const checkCommands: string[] = [];
  const seen = new Set<string>();
  const push = (cmd: string) => {
    const c = cmd.trim();
    if (!c || seen.has(c)) return;
    seen.add(c);
    checkCommands.push(c);
  };

  if (pm && (kinds.includes("node") || exists(root, "package.json"))) {
    for (const c of nodeCheckCommands(root, pm)) push(c);
  }
  // Turbo / Nx monorepo runners — prefer when config present (expert monorepos).
  if (exists(root, "turbo.json")) {
    // Root package scripts often wrap turbo; still surface direct turbo targets.
    push("turbo run typecheck");
    push("turbo run test");
    push("turbo run lint");
    push("turbo run build");
    if (!kinds.includes("monorepo")) kinds.push("monorepo");
    if (!kinds.includes("turbo")) kinds.push("turbo");
  }
  if (exists(root, "nx.json")) {
    push("nx run-many -t test");
    push("nx run-many -t lint");
    push("nx run-many -t build");
    if (!kinds.includes("monorepo")) kinds.push("monorepo");
    if (!kinds.includes("nx")) kinds.push("nx");
  }
  for (const c of otherEcosystemCommands(root, kinds)) push(c);

  // Cap so the system prompt stays lean.
  const capped = checkCommands.slice(0, 8);

  const bits: string[] = [];
  if (packageName) {
    bits.push(packageVersion ? `${packageName}@${packageVersion}` : packageName);
  }
  if (pm) bits.push(pm);
  if (kinds.length) bits.push(kinds.join("+"));
  if (workspaces.length) {
    bits.push(
      `ws=${workspaces.length}` +
        (workspaces[0] ? `:${workspaces[0].split(" ")[0]}` : ""),
    );
  }
  if (capped.length) bits.push(`checks: ${capped.slice(0, 4).join(" · ")}`);

  return {
    kinds,
    packageManager: pm,
    packageName,
    packageVersion,
    checkCommands: capped,
    workspaces,
    summary: bits.join(" · "),
  };
}

/**
 * One-line suffix for successful file mutations — nudges the model toward the
 * cheapest project check without user steering. Empty when nothing detected,
 * FORGE_VERIFY_HINT=0, or the edit was pure docs (no code verification needed).
 */
export function verifyHintSuffix(cwd: string, filePath?: string): string {
  const v = (process.env.FORGE_VERIFY_HINT || "1").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return "";
  // Pure documentation / lockfiles — don't nag for npm test after README edits.
  if (filePath) {
    const base = path.basename(filePath).toLowerCase();
    const ext = path.extname(filePath).toLowerCase();
    if (
      ext === ".md" ||
      ext === ".mdx" ||
      ext === ".txt" ||
      ext === ".rst" ||
      base === "license" ||
      base === "changelog" ||
      base === "changelog.md"
    ) {
      return "";
    }
  }
  try {
    const intel = detectProjectIntel(cwd);
    const cmd = intel.checkCommands[0];
    if (!cmd) return "";
    return `\nTip: verify with \`${cmd}\``;
  } catch {
    return "";
  }
}

/**
 * Detect multiple Node lockfiles present (ambiguous package manager).
 * Returns the list of lockfile basenames when ≥2 families are present.
 */

/**
 * Mid-loop structural nudge when the session has edits without a fresh green
 * verification. Injected as a synthetic user message so the model runs a check
 * before more churn — reduces "shall I run tests?" steering.
 *
 * Returns empty when disabled, no checks known, or verification is still fresh.
 * FORGE_AUTO_VERIFY_NUDGE=0 disables. Threshold via FORGE_AUTO_VERIFY_EDIT_THRESHOLD (default 8).
 */
export function midLoopVerifyNudge(sessionMeta: {
  editCount?: number;
  lastEditAt?: string | null;
  lastVerificationAt?: string | null;
  lastVerificationCommand?: string | null;
  lastVerificationExitCode?: number | null;
}, cwd: string): string {
  const off = (process.env.FORGE_AUTO_VERIFY_NUDGE || "1").trim().toLowerCase();
  if (off === "0" || off === "false" || off === "off" || off === "no") return "";
  const threshold = Math.max(
    1,
    Math.min(
      20,
      Number.parseInt(process.env.FORGE_AUTO_VERIFY_EDIT_THRESHOLD || "8", 10) || 8,
    ),
  );
  const edits = Number(sessionMeta.editCount || 0);
  if (edits < threshold) return "";
  // Fresh green verification after last edit → silence
  try {
    const lastEdit = sessionMeta.lastEditAt
      ? Date.parse(String(sessionMeta.lastEditAt))
      : NaN;
    const lastVer = sessionMeta.lastVerificationAt
      ? Date.parse(String(sessionMeta.lastVerificationAt))
      : NaN;
    const exit = sessionMeta.lastVerificationExitCode;
    if (
      Number.isFinite(lastEdit) &&
      Number.isFinite(lastVer) &&
      lastVer >= lastEdit &&
      (exit === 0 || exit === undefined || exit === null)
    ) {
      return "";
    }
  } catch {
    /* */
  }
  let cmd = "npm test";
  try {
    const intel = detectProjectIntel(cwd);
    cmd = intel.checkCommands[0] || cmd;
  } catch {
    /* */
  }
  const lastCmd = sessionMeta.lastVerificationCommand
    ? String(sessionMeta.lastVerificationCommand)
    : "";
  return (
    `[Forge harness — verify nudge]\n` +
    `Session has ${edits} edit(s) without a fresh green verification` +
    (lastCmd ? ` (last: ${lastCmd})` : "") +
    `.\n` +
    `Run the cheapest project check now before more edits: \`${cmd}\` ` +
    `(or the tighter sibling if you only touched a narrow surface). ` +
    `Do not ask the user whether to verify — just run it, then continue.`
  );
}


export function multipleLockfiles(cwd: string): string[] {
  const root = path.resolve(cwd || process.cwd());
  const found: string[] = [];
  if (exists(root, "pnpm-lock.yaml")) found.push("pnpm-lock.yaml");
  if (exists(root, "yarn.lock")) found.push("yarn.lock");
  if (exists(root, "bun.lockb") || exists(root, "bun.lock")) {
    found.push(exists(root, "bun.lockb") ? "bun.lockb" : "bun.lock");
  }
  if (exists(root, "package-lock.json") || exists(root, "npm-shrinkwrap.json")) {
    found.push(
      exists(root, "package-lock.json")
        ? "package-lock.json"
        : "npm-shrinkwrap.json",
    );
  }
  return found.length >= 2 ? found : [];
}

/**
 * Detect package.json "packageManager" field disagreeing with lockfiles.
 * Experts hit this after switching PM without cleaning lockfiles.
 * Returns null when consistent or insufficient signal.
 */
/**
 * When install fails and multiple lockfiles exist, tip to pick one PM.
 */
export function multipleLockfilesTip(
  command: string,
  cwd: string,
): string | null {
  const cmd = String(command || "");
  if (!/\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add)\b/i.test(cmd)) {
    return null;
  }
  const multi = multipleLockfiles(cwd);
  if (multi.length < 2) return null;
  return (
    `Multiple lockfiles present (${multi.join(", ")}). ` +
    `Install with the intended PM only and remove the other lockfile(s) to avoid drift.`
  );
}

export function packageManagerLockfileMismatch(
  cwd: string,
): { field: PackageManager; lockfile: PackageManager; detail: string } | null {
  const root = path.resolve(cwd || process.cwd());
  const pkg = readJson(path.join(root, "package.json"));
  const fieldRaw =
    typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
  const field = fieldRaw.split("@")[0]?.trim().toLowerCase() as
    | PackageManager
    | "";
  if (field !== "npm" && field !== "pnpm" && field !== "yarn" && field !== "bun") {
    return null;
  }

  const locks: Array<{ pm: PackageManager; file: string }> = [];
  if (exists(root, "pnpm-lock.yaml") || exists(root, "pnpm-workspace.yaml")) {
    locks.push({ pm: "pnpm", file: "pnpm-lock.yaml" });
  }
  if (exists(root, "yarn.lock") || exists(root, ".yarnrc.yml")) {
    locks.push({ pm: "yarn", file: "yarn.lock" });
  }
  if (exists(root, "bun.lockb") || exists(root, "bun.lock")) {
    locks.push({ pm: "bun", file: "bun.lock" });
  }
  if (exists(root, "package-lock.json") || exists(root, "npm-shrinkwrap.json")) {
    locks.push({ pm: "npm", file: "package-lock.json" });
  }
  if (!locks.length) return null;

  // Prefer the strongest conflicting lockfile (any lock that isn't the field PM).
  const conflict = locks.find((l) => l.pm !== field);
  if (!conflict) return null;
  // If field's lock is also present, still warn about the extra foreign lock.
  return {
    field,
    lockfile: conflict.pm,
    detail:
      `package.json packageManager="${fieldRaw.trim()}" but ${conflict.file} is present ` +
      `(detected lock PM=${conflict.pm}). Remove the stale lockfile or align packageManager.`,
  };
}

/**
 * Whether dependencies appear installed for this cwd.
 * Checks local node_modules, then monorepo root (hoisted installs).
 * Returns null when there is no package.json in cwd or monorepo root.
 */
export function hasNodeModules(cwd: string): boolean | null {
  const root = path.resolve(cwd || process.cwd());
  const hasPkg = exists(root, "package.json");
  if (exists(root, "node_modules")) return true;
  try {
    const mono = findMonorepoRoot(root);
    if (mono && mono !== root) {
      if (exists(mono, "node_modules")) return true;
      if (exists(mono, "package.json") || hasPkg) {
        // package.json somewhere in the monorepo, but no node_modules at root/local
        return false;
      }
    }
  } catch {
    /* */
  }
  if (!hasPkg) return null;
  return false;
}

/**
 * When bash fails with EACCES/permission denied on a workspace path, give a
 * concrete recovery tip (don't thrash the same command).
 */
export function permissionDeniedTip(
  command: string,
  stderrOrBody: string,
): string | null {
  const body = String(stderrOrBody || "");
  if (!/EACCES|permission denied|Operation not permitted/i.test(body)) {
    return null;
  }
  // Don't tip on sandbox intentional denies (already explained elsewhere).
  if (/sandbox|denied by policy|IMDS|169\.254/i.test(body)) return null;
  const cmd = String(command || "").trim();
  if (!cmd) return null;
  return (
    `Permission denied running: ${cmd.slice(0, 120)}${cmd.length > 120 ? "…" : ""}. ` +
    `Check file ownership/mode, avoid writing outside the workspace, or re-run with the correct user. ` +
    `If this is plan mode, use /build before mutations.`
  );
}

/**
 * When a shell fails with Cannot find module / MODULE_NOT_FOUND and
 * node_modules is missing, steer install with the detected package manager.
 */
export function missingNodeModulesTip(
  stderrOrBody: string,
  cwd: string,
): string | null {
  const body = String(stderrOrBody || "");
  if (
    !/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find package/i.test(
      body,
    )
  ) {
    return null;
  }
  try {
    const root = path.resolve(cwd || process.cwd());
    if (!exists(root, "package.json") && !findMonorepoRoot(root)) return null;
    if (hasNodeModules(root) !== false) return null;
    const pm = detectPackageManager(root) || "npm";
    const install =
      pm === "pnpm"
        ? "pnpm install"
        : pm === "yarn"
          ? "yarn install"
          : pm === "bun"
            ? "bun install"
            : "npm install";
    const mono = findMonorepoRoot(root);
    const where =
      mono && mono !== root ? ` (from monorepo root ${mono})` : "";
    return `node_modules missing — run \`${install}\`${where} then retry`;
  } catch {
    return null;
  }
}

/**
 * When a shell error looks like a monorepo/workspace layout mistake, point at
 * the monorepo root and preferred root checks.
 */
export function monorepoLayoutTip(
  stderrOrBody: string,
  cwd: string,
): string | null {
  const body = String(stderrOrBody || "");
  if (
    !/ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND|ERR_PNPM_WORKSPACE_PKG_NOT_FOUND|not a workspace|workspace root|no such file or directory.*package\.json|This project is configured to use yarn|use yarn|use pnpm|use npm/i.test(
      body,
    )
  ) {
    // Also catch "running from wrong directory" style turbo/nx errors.
    if (
      !/turbo\.json|nx\.json|could not find.*workspace|No projects found/i.test(
        body,
      )
    ) {
      return null;
    }
  }
  try {
    const intel = detectProjectIntel(cwd);
    if (!intel.monorepoRoot && !intel.workspaces.length) return null;
    const root = intel.monorepoRoot || cwd;
    const check = intel.checkCommands[0];
    const bits = [`Monorepo root: ${root}`];
    if (intel.workspaces[0]) {
      bits.push(`workspaces include ${intel.workspaces[0]}`);
    }
    if (check) bits.push(`try from root: ${check}`);
    else bits.push(`cd ${root} then re-run`);
    return bits.join(" · ");
  } catch {
    return null;
  }
}

/**
 * When a verification command fails, suggest the next preferred project check
 * so the agent doesn't stall or invent an alternate stack.
 */
export function nextCheckTip(command: string, cwd: string): string | null {
  const cmd = String(command || "").replace(/\s+/g, " ").trim();
  if (!cmd) return null;
  try {
    // Only tip when the failed command looks like a check (or is preferred).
    const intel = detectProjectIntel(cwd);
    const preferred = intel.checkCommands;
    if (!preferred.length) return null;
    const isCheck =
      isVerificationish(cmd) ||
      preferred.some(
        (p) =>
          cmd === p ||
          cmd.endsWith(` && ${p}`) ||
          cmd.endsWith(`; ${p}`) ||
          cmd.includes(p),
      );
    if (!isCheck) return null;

    // Find which preferred command was attempted (best match).
    let idx = preferred.findIndex(
      (p) => cmd === p || cmd.endsWith(` && ${p}`) || cmd.endsWith(`; ${p}`),
    );
    if (idx < 0) {
      idx = preferred.findIndex((p) => cmd.includes(p));
    }
    if (idx < 0) {
      // Generic check failed — suggest cheapest preferred.
      return `Verification failed. Next try: ${preferred[0]}`;
    }
    const next = preferred[idx + 1];
    if (!next) {
      return null; // already last preferred
    }
    return `Verification failed. Next try: ${next}`;
  } catch {
    return null;
  }
}

function isVerificationish(cmd: string): boolean {
  // Prefer runner-shaped commands — avoid "git commit -m fix test" false positives.
  return (
    /\b(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|tests|typecheck|type-check|lint|check|build|ci|verify|smoke|tsc)\b/i.test(
      cmd,
    ) ||
    /\b(?:pytest|cargo\s+test|go\s+test|mix\s+test|composer\s+test|turbo\s+run|nx\s+(?:run-many|run)|tsc\b|eslint\b|make\s+(?:test|check)|npx\s+(?:tsc|eslint|vitest|jest))\b/i.test(
      cmd,
    )
  );
}

/**
 * When a shell reports command-not-found for a known check binary, suggest
 * the project's preferred verification command instead (npx / package script).
 */
export function missingBinaryTip(
  command: string,
  stderrOrBody: string,
  cwd: string,
): string | null {
  const body = String(stderrOrBody || "");
  if (
    !/command not found|not found|ENOENT|No such file or directory/i.test(body)
  ) {
    return null;
  }
  // Leading token of the failed command (ignore env assignments).
  const cleaned = command
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  const bin = cleaned.split(/\s+/)[0]?.replace(/^["']|["']$/g, "") || "";
  if (!bin) return null;
  const base = path.basename(bin);
  // Only tip for common toolchain binaries — not arbitrary missing cmds.
  const known = new Set([
    "tsc",
    "eslint",
    "prettier",
    "jest",
    "vitest",
    "mocha",
    "pytest",
    "cargo",
    "go",
    "turbo",
    "nx",
    "ruff",
    "mypy",
    "pyright",
  ]);
  if (!known.has(base)) return null;

  try {
    const intel = detectProjectIntel(cwd);
    const preferred = intel.checkCommands[0];
    const pm = intel.packageManager || detectPackageManager(cwd);
    const runner = (binName: string, args = ""): string => {
      const a = args ? ` ${args}` : "";
      if (pm === "pnpm") return `pnpm dlx ${binName}${a}`;
      if (pm === "yarn") return `yarn dlx ${binName}${a}`;
      if (pm === "bun") return `bunx ${binName}${a}`;
      return `npx ${binName}${a}`;
    };
    if (preferred && !preferred.split(/\s+/)[0]?.endsWith(base)) {
      return (
        `"${base}" not found on PATH. Prefer project check: ${preferred}` +
        (base === "tsc" ? `  (or ${runner("tsc", "--noEmit")})` : "")
      );
    }
    if (base === "tsc") {
      return (
        `"tsc" not found on PATH. Try: ${runner("tsc", "--noEmit")}` +
        (preferred ? `  ·  or ${preferred}` : "")
      );
    }
    if (
      base === "eslint" ||
      base === "prettier" ||
      base === "jest" ||
      base === "vitest"
    ) {
      return (
        `"${base}" not found on PATH. Try: ${runner(base)}` +
        (preferred ? `  ·  or ${preferred}` : "")
      );
    }
    if (preferred) {
      return `"${base}" not found on PATH. Prefer project check: ${preferred}`;
    }
  } catch {
    /* */
  }
  return null;
}

/**
 * When npm/pnpm/yarn/bun reports a missing script, suggest known scripts
 * from package.json (and preferred checks). Pure helper for bash recovery.
 */
export function missingScriptTip(
  _command: string,
  stderrOrBody: string,
  cwd: string,
): string | null {
  const body = String(stderrOrBody || "");
  // npm: Missing script: "foo" · pnpm: Command "foo" not found · yarn: error Command "foo" not found.
  const missing =
    body.match(/Missing script:\s*["'`]?([A-Za-z0-9:_-]+)/i) ||
    body.match(/Command\s+["'`]([A-Za-z0-9:_-]+)["'`]\s+not found/i) ||
    body.match(/error Command ["'`]([A-Za-z0-9:_-]+)["'`] not found/i);
  if (!missing) return null;

  const wanted = missing[1];
  const root = path.resolve(cwd || process.cwd());
  const pkg = readJson(path.join(root, "package.json"));
  const scripts =
    pkg?.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  const names = Object.keys(scripts).filter(
    (k) => typeof scripts[k] === "string" && String(scripts[k]).trim(),
  );
  if (!names.length) return null;

  const pm = detectPackageManager(root) || "npm";
  // Prefer close names + priority scripts first.
  const ranked = [...names].sort((a, b) => {
    const da = editDistance(wanted.toLowerCase(), a.toLowerCase());
    const db = editDistance(wanted.toLowerCase(), b.toLowerCase());
    // Strong preference for near-typos (distance ≤ 2 or shared prefix).
    const ta = da <= 2 || a.startsWith(wanted) || wanted.startsWith(a) ? 0 : 1;
    const tb = db <= 2 || b.startsWith(wanted) || wanted.startsWith(b) ? 0 : 1;
    if (ta !== tb) return ta - tb;
    if (da !== db) return da - db;
    const sa = SCRIPT_PRIORITY.indexOf(a as (typeof SCRIPT_PRIORITY)[number]);
    const sb = SCRIPT_PRIORITY.indexOf(b as (typeof SCRIPT_PRIORITY)[number]);
    const pa = sa === -1 ? 99 : sa;
    const pb = sb === -1 ? 99 : sb;
    if (pa !== pb) return pa - pb;
    // Prefer prefix/substring match to the missing name.
    const ma = a.includes(wanted) || wanted.includes(a) ? 0 : 1;
    const mb = b.includes(wanted) || wanted.includes(b) ? 0 : 1;
    if (ma !== mb) return ma - mb;
    return a.localeCompare(b);
  });
  const top = ranked.slice(0, 6).map((n) => runScript(pm, n));
  const best = ranked[0]!;
  const bestDist = editDistance(wanted.toLowerCase(), best.toLowerCase());
  const didYouMean =
    bestDist > 0 &&
    bestDist <= 2 &&
    best !== wanted
      ? ` Did you mean: ${runScript(pm, best)}?`
      : "";
  return (
    `Script "${wanted}" is not defined.${didYouMean} Available: ${top.join(" · ")}` +
    (ranked.length > 6 ? ` (+${ranked.length - 6} more)` : "")
  );
}

/**
 * When a shell command used the wrong Node package manager, suggest the
 * detected one. Pure helper — used by bash tool error recovery.
 * Also parses Corepack stderr ("This project is configured to use yarn").
 */
export function wrongPackageManagerTip(
  command: string,
  pm: PackageManager | undefined,
  stderrOrBody?: string,
): string | null {
  const cmd = command.trim();
  // Corepack / packageManager-field enforcement in stderr.
  const body = String(stderrOrBody || "");
  const corepack = body.match(
    /(?:configured to use|use)\s+(npm|pnpm|yarn|bun)\b/i,
  );
  if (corepack) {
    const want = corepack[1]!.toLowerCase() as PackageManager;
    if (cmd) {
      const usedM = cmd.match(
        /(?:^|[;&|]\s*|&&\s*|\|\|\s*)(npm|pnpm|yarn|bun)(?:\s|$)/,
      );
      const used = usedM?.[1] as PackageManager | undefined;
      if (used && used !== want) {
        const rewritten = cmd.replace(
          new RegExp(`(^|[;&|]|&&|\\|\\|)(\\s*)${used}(?=\\s|$)`),
          `$1$2${want}`,
        );
        return (
          `Corepack/packageManager requires ${want}, but this command used ${used}. ` +
          `Retry with: ${rewritten === cmd ? `${want} …` : rewritten}`
        );
      }
    }
    return `Corepack/packageManager requires ${want}. Retry with ${want} instead of npm/pnpm/yarn/bun mismatch.`;
  }

  if (!pm) return null;
  if (!cmd) return null;
  // Match leading package-manager invocations (not mid-pipeline noise).
  const m = cmd.match(
    /(?:^|[;&|]\s*|&&\s*|\|\|\s*)(npm|pnpm|yarn|bun)(?:\s|$)/,
  );
  if (!m) return null;
  const used = m[1] as PackageManager;
  if (used === pm) return null;

  // Rewrite first occurrence of the wrong PM for a concrete tip.
  const rewritten = cmd.replace(
    new RegExp(`(^|[;&|]|&&|\\|\\|)(\\s*)${used}(?=\\s|$)`),
    `$1$2${pm}`,
  );
  return (
    `Project uses ${pm}, but this command used ${used}. ` +
    `Retry with: ${rewritten === cmd ? `${pm} …` : rewritten}`
  );
}

/**
 * Stable system-prompt block (no branch/dirty volatility).
 * Empty string when nothing useful was detected.
 */
export function formatProjectIntelForPrompt(intel: ProjectIntel): string {
  if (
    !intel.kinds.length &&
    !intel.checkCommands.length &&
    !intel.packageName &&
    !(intel.workspaces && intel.workspaces.length)
  ) {
    return "";
  }
  const lines: string[] = [];
  const head: string[] = [];
  if (intel.packageName) {
    head.push(
      intel.packageVersion
        ? `${intel.packageName}@${intel.packageVersion}`
        : intel.packageName,
    );
  }
  if (intel.packageManager) head.push(`pm=${intel.packageManager}`);
  if (intel.kinds.length) head.push(intel.kinds.join("+"));
  if (head.length) lines.push(`Project: ${head.join(" · ")}`);
  if (intel.monorepoRoot) {
    lines.push(`Monorepo root: ${intel.monorepoRoot}`);
  }
  if (intel.workspaces?.length) {
    lines.push(
      `Workspaces: ${intel.workspaces.slice(0, 8).join("  ·  ")}` +
        (intel.workspaces.length > 8
          ? ` (+${intel.workspaces.length - 8} more)`
          : ""),
      `Monorepo: prefer package-scoped checks (cd <pkg> && …) when editing a single workspace; use root Commands for whole-repo verification.`,
    );
  }
  if (intel.checkCommands.length) {
    lines.push(
      `Commands: ${intel.checkCommands.join("  ·  ")}`,
      `Prefer these project commands for verification (cheapest first). Do not invent alternate package managers when one is detected.`,
    );
  }
  return lines.join("\n");
}
